"""Ask whether the trouble sits on one measurement or spreads across neighbours.

An independent second opinion on the same question isolation answers, and it is
independent in the way that matters: isolation asks whether a bias on one point can
be made to FIT the numbers, while this asks a purely structural question about
WHERE in the graph the trouble is, without fitting anything.

The physical argument is short. A sensor that reads wrong makes the relations
containing that sensor inconsistent and leaves every other relation exactly as it
was, because nothing about the machine changed. Equipment that degrades changes the
physical state, and the physical state appears in several relations at once, so
relations sharing no single sensor all move together.

So for a candidate point: add up the violation carried by relations that include it,
and compare against the violation carried by every relation in its neighbourhood --
the relations reachable through points it shares a relation with. Near one means the
trouble is confined to relations this point can explain. Near zero means its
neighbours are just as upset as it is, and a bias on it cannot be the story.

WHY THIS IS COMPUTED ON RESIDUALS AND NOT ON THE RAW READINGS

The obvious reading of "one node moves, its neighbours do not" is to look for one
measurement that shifted while the measurements around it held still. That is wrong
here, and measurably so. These air handlers run closed control loops. When the
supply air sensor drifts high, the controller believes the air is too warm and opens
the chilled water valve until the READING comes back to setpoint -- so the reading
barely moves at all, while the valve position moves a great deal. Measured over
these runs, mean valve position goes from 0.310 on the fault-free run to 0.445 on
the sensor-drift run, and supply air temperature relative to its setpoint actually
moves LESS than on the clean run. In raw measurement space a drifting sensor looks
distributed and its neighbours look guilty.

Residuals do not have that problem, because a control loop can hide a fault from a
measurement but it cannot make a physical relation hold that does not hold. The
controller closing the loop around a wrong number is precisely what leaves the coil
energy balance out by the size of the bias.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from analytics.diagnosis.isolation import MIN_SHIFT_SIGMA, Relation

log = logging.getLogger("diagnosis.coherence")

# Above this a fault is treated as localised enough for a single measurement to be
# the story. Two thirds rather than a half: a bare majority of the violation
# sitting on relations that contain the suspect is not much of a case, since any
# point in a violated relation gets credit for all of it. Measured over these runs
# the separation is not close -- the drifting sensor scores 1.00 and the stuck
# damper 0.64 -- so the exact value is not doing subtle work.
LOCALISED_ABOVE = 0.66


@dataclass(frozen=True)
class Locality:
    """How concentrated the trouble is around one point."""

    point_id: str
    own_violation: float  # summed |shift| in sigmas, relations containing it
    neighbourhood_violation: float  # the same across its whole neighbourhood
    own_relations: tuple[str, ...]
    neighbour_relations: tuple[str, ...]  # nearby relations it does NOT appear in

    @property
    def score(self) -> float:
        """Share of the neighbourhood's violation that this point could explain."""
        if self.neighbourhood_violation <= 0.0:
            return 0.0
        return self.own_violation / self.neighbourhood_violation

    @property
    def localised(self) -> bool:
        return self.score >= LOCALISED_ABOVE

    @property
    def verdict(self) -> str:
        if self.neighbourhood_violation <= 0.0:
            return "nothing violated anywhere near this point"
        if self.localised:
            return (
                f"localised: {self.score * 100:.0f} percent of the violation nearby "
                f"is on relations containing it"
            )
        return (
            f"distributed: only {self.score * 100:.0f} percent of the violation "
            f"nearby is on relations containing it, so coupled measurements moved too"
        )


def neighbours(relations: list[Relation], point_id: str) -> set[str]:
    """Points sharing at least one relation with this one.

    The graph is never built as an object because it is only ever used one node at
    a time, and the relation list already IS the adjacency: two points are
    neighbours exactly when some relation reads both.
    """
    out: set[str] = set()
    for relation in relations:
        if point_id in relation.sensitivity:
            out |= set(relation.sensitivity)
    out.discard(point_id)
    return out


def locality(relations: list[Relation], point_id: str) -> Locality:
    """Localisation score for one candidate point over one window.

    Violation is summed in units of each relation's own reference spread, so a
    chiller energy balance in watts and a coil balance in kelvin contribute on the
    same footing. Relations below the violation threshold contribute nothing at all
    rather than a little: a neighbourhood of quiet relations should not dilute a
    real localised fault just by being numerous.
    """
    nearby = neighbours(relations, point_id)

    own_ids: list[str] = []
    neighbour_ids: list[str] = []
    own_total = 0.0
    neighbour_total = 0.0
    for relation in relations:
        if not relation.violated:
            continue
        magnitude = abs(relation.shift_sigma)
        if point_id in relation.sensitivity:
            own_ids.append(relation.relation_id)
            own_total += magnitude
        elif nearby & set(relation.sensitivity):
            neighbour_ids.append(relation.relation_id)
            neighbour_total += magnitude

    return Locality(
        point_id=point_id,
        own_violation=own_total,
        neighbourhood_violation=own_total + neighbour_total,
        own_relations=tuple(own_ids),
        neighbour_relations=tuple(neighbour_ids),
    )


def spread(relations: list[Relation]) -> float:
    """How many distinct relations are violated, as a blunt distribution measure.

    Used when there is no credible single suspect to score. A fault that has upset
    four relations at once is not a sensor whatever the localisation of any
    individual point says, and this is the number that says so without needing to
    pick a candidate first.
    """
    return float(sum(1 for r in relations if r.violated))


def independent_sets(relations: list[Relation]) -> int:
    """Count violated relations that share no point with any other violated one.

    Two violated relations with a point in common can be explained by that point.
    Two with nothing in common cannot be explained by any single measurement at all,
    and that is a structural fact about the graph rather than a fitted one -- it
    holds before any least squares is run and it cannot be argued with.
    """
    violated = [r for r in relations if r.violated]
    isolated = 0
    for index, relation in enumerate(violated):
        others: set[str] = set()
        for other_index, other in enumerate(violated):
            if other_index != index:
                others |= set(other.sensitivity)
        if not (set(relation.sensitivity) & others):
            isolated += 1
    return isolated


def most_localised(relations: list[Relation], candidates: list[str]) -> Locality | None:
    """The candidate whose trouble is most concentrated on itself."""
    scored = [locality(relations, point_id) for point_id in candidates]
    live = [s for s in scored if s.neighbourhood_violation > 0.0]
    return max(live, key=lambda s: s.score) if live else None


def violated_summary(relations: list[Relation]) -> str:
    """One line naming what is violated and by how much, for the evidence record."""
    violated = sorted(
        (r for r in relations if r.violated), key=lambda r: -abs(r.shift_sigma)
    )
    if not violated:
        return f"no relation moved by more than {MIN_SHIFT_SIGMA:.1f} sigma"
    return ", ".join(
        f"{r.relation_id} {r.shift_sigma:+.2f} sigma" for r in violated
    )
