/**
 * Properties the deck must hold, checked against the script rather than against a snapshot
 * of how it currently renders.
 *
 * WHY THIS EXISTS WHEN THE PROJECT HAS NO TESTS. It is not a test suite; it is the same
 * thing every other verify-*.ts in this directory is — a statement of what must be true,
 * run on demand, that fails loudly. The deck's failure modes are structural and silent: a
 * panel chip pointing at an identifier the catalogue no longer has renders "no rule with
 * that identifier" in front of the audience, and nothing else in the toolchain would ever
 * say so. Neither would a typechecker, because the identifiers are strings.
 *
 * Run with `npm run verify:deck`.
 */

import {
  ACTS,
  SLIDES,
  actRanges,
  allPanelRefs,
  slidesInAct,
} from "../src/deck/deck.ts";
import {
  ASSETS,
  BASELINES,
  CHECKS,
  METRICS,
  MODES,
  RULES,
  SCENARIOS,
} from "../src/deck/catalogue.ts";

let failures = 0;
const results: string[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push(`${ok ? "  ok  " : "FAIL  "}${name} — ${detail}`);
  if (!ok) failures += 1;
}

/* ------------------------------------------------------------------ structural shape */

check(
  "every act has slides",
  ACTS.every((a) => slidesInAct(a.id).length > 0),
  ACTS.map((a) => `${a.id}:${slidesInAct(a.id).length}`).join(" "),
);

/*
 * An act's slides must be contiguous. If a slide is tagged with an act it does not sit
 * inside, the rail draws that act as two runs with somebody else's slides in the middle,
 * and a listener reading the rail is told the presentation went backwards.
 */
{
  const ranges = actRanges();
  const contiguous = ranges.every(({ act, from, to }) => {
    for (let i = from; i <= to; i += 1) if (SLIDES[i]!.act !== act.id) return false;
    return true;
  });
  check("acts are contiguous", contiguous, "no act's slides are interrupted by another act's");
}

/*
 * Every act except the bookends opens with an orientation slide and closes with one.
 * That repetition IS the orientation aid — it is what picks up a listener who lost the
 * thread — so an act missing one is a hole in the thing this deck was restructured for.
 */
{
  const middle = ACTS.filter((a) => a.id !== "claim" && a.id !== "close");
  const bad = middle.filter((a) => {
    const s = slidesInAct(a.id);
    return s[0]?.kind !== "open" || s[s.length - 1]?.kind !== "close";
  });
  check(
    "every act opens and closes with an orientation slide",
    bad.length === 0,
    bad.length === 0 ? `${middle.length} acts, all bracketed` : `missing on: ${bad.map((a) => a.id).join(", ")}`,
  );
}

check(
  "slide ids are unique",
  new Set(SLIDES.map((s) => s.id)).size === SLIDES.length,
  `${SLIDES.length} slides, ${new Set(SLIDES.map((s) => s.id)).size} distinct ids`,
);

/* An open slide must say what is already standing; a close slide must say what is in hand. */
{
  const opens = SLIDES.filter((s) => s.kind === "open");
  const closes = SLIDES.filter((s) => s.kind === "close");
  check(
    "open slides carry a standing list",
    opens.every((s) => (s.standing?.length ?? 0) > 0),
    `${opens.length} open slides`,
  );
  check(
    "close slides carry a gained list",
    closes.every((s) => (s.gained?.length ?? 0) > 0),
    `${closes.length} close slides`,
  );
}

/* ---------------------------------------------------------------- panels resolve */

/*
 * THE CHECK THIS FILE EXISTS FOR. Chips carry a string identifier into the catalogue. A
 * renamed rule or a dropped scenario leaves the chip pointing at nothing, and the failure is
 * invisible until somebody clicks it in front of the audience.
 */
{
  const known: Record<string, Set<string>> = {
    scenario: new Set(SCENARIOS.map((s) => s.id)),
    asset: new Set(ASSETS.map((a) => a.id)),
    rule: new Set(RULES.map((r) => r.id)),
    check: new Set(CHECKS.map((c) => c.id)),
    baseline: new Set(BASELINES.map((b) => b.id)),
    mode: new Set(MODES.map((m) => m.id)),
    metric: new Set(METRICS.map((m) => m.id)),
    // Authored in Panel.tsx rather than in the catalogue, because they are explanations
    // rather than data. Listed here so a typo is still caught.
    maths: new Set(["blend-formula", "least-squares", "cusum", "first-passage"]),
  };
  const refs = allPanelRefs();
  const dangling = refs.filter((r) => !known[r.kind]?.has(r.id));
  check(
    "every panel chip resolves to catalogue data",
    dangling.length === 0,
    dangling.length === 0
      ? `${refs.length} chips, all resolve`
      : `dangling: ${dangling.map((r) => `${r.kind}:${r.id}`).join(", ")}`,
  );
}

/* Everything in the catalogue that is worth showing should be reachable from some slide. */
{
  const refs = allPanelRefs();
  const reachable = (kind: string, ids: string[]) =>
    ids.filter((id) => !refs.some((r) => r.kind === kind && r.id === id));
  const missing = [
    ...reachable("rule", RULES.map((r) => r.id)).map((i) => `rule:${i}`),
    ...reachable("scenario", SCENARIOS.map((s) => s.id)).map((i) => `scenario:${i}`),
    ...reachable("mode", MODES.map((m) => m.id)).map((i) => `mode:${i}`),
    ...reachable("check", CHECKS.map((c) => c.id)).map((i) => `check:${i}`),
    ...reachable("baseline", BASELINES.map((b) => b.id)).map((i) => `baseline:${i}`),
    ...reachable("metric", METRICS.map((m) => m.id)).map((i) => `metric:${i}`),
  ];
  check(
    "nothing in the catalogue is unreachable",
    missing.length === 0,
    missing.length === 0 ? "every rule, scenario, mode, check, baseline and metric has a chip" : `orphaned: ${missing.join(", ")}`,
  );
}

/* ------------------------------------------------------------------ content limits */

/*
 * A slide is a fixed height and never scrolls. These caps are what keep the script from
 * quietly authoring a slide that runs off the bottom of a projector.
 *
 * Six points at the measured line height is the most that fits beside a figure at the
 * deck's 24px body size; the character cap is set from the same measurement, since a bullet
 * that wraps to three lines occupies the space of three bullets.
 */
{
  const MAX_POINTS = 6;
  const MAX_CHARS = 190;
  const fat = SLIDES.filter((s) => (s.points?.length ?? 0) > MAX_POINTS);
  check(
    "no slide has more than six points",
    fat.length === 0,
    fat.length === 0 ? `worst is ${Math.max(...SLIDES.map((s) => s.points?.length ?? 0))}` : fat.map((s) => s.id).join(", "),
  );

  const long = SLIDES.flatMap((s) =>
    [...(s.points ?? []), ...(s.standing ?? []), ...(s.gained ?? [])]
      .filter((p) => p.replace(/\*/g, "").length > MAX_CHARS)
      .map((p) => `${s.id}: ${p.replace(/\*/g, "").length} chars`),
  );
  check(
    "no bullet runs past the wrap limit",
    long.length === 0,
    long.length === 0
      ? `worst is ${Math.max(
          ...SLIDES.flatMap((s) =>
            [...(s.points ?? []), ...(s.standing ?? []), ...(s.gained ?? [])].map((p) => p.replace(/\*/g, "").length),
          ),
        )} chars`
      : long.join("; "),
  );

  const leads = SLIDES.filter((s) => (s.lead?.length ?? 0) > 165);
  check("no standfirst runs long", leads.length === 0, leads.length === 0 ? "all leads under 165 chars" : leads.map((s) => s.id).join(", "));
}

/*
 * TOTAL COPY BUDGET — the guard against the failure this deck actually shipped.
 *
 * A slide never scrolls, so the amount of copy on it has to fit above the chips row at the
 * SHORTEST window anybody will present on. The first version had none of this: the type
 * sizes were constants chosen against a 900px-tall viewport, and on an ordinary laptop
 * browser showing 800px fourteen slides ran their last bullet straight through the chips
 * row. Nothing failed, because the copy still fitted inside the section — it was colliding
 * with the row below it, not overflowing the slide.
 *
 * This file cannot measure a browser, so it cannot check the collision directly. What it can
 * do is cap the input to it. The type scale now shrinks with window height and a full
 * five-viewport browser walk (down to 1280x720) is clean at the budget below; 660 leaves
 * roughly five percent of headroom over the longest slide as it stands. A slide that trips
 * this has not necessarily broken — but it has left the range that was actually measured,
 * and it needs re-walking in a browser before it is presented.
 */
{
  const BUDGET = 660;
  const weight = (s: (typeof SLIDES)[number]) =>
    [s.lead ?? "", ...(s.points ?? []), ...(s.standing ?? []), ...(s.gained ?? [])]
      .reduce((a, t) => a + t.replace(/\*/g, "").length, 0);
  const heavy = SLIDES.filter((s) => weight(s) > BUDGET);
  const worst = Math.max(...SLIDES.map(weight));
  check(
    "no slide carries more copy than the shortest window holds",
    heavy.length === 0,
    heavy.length === 0
      ? `worst is ${worst} of ${BUDGET} chars`
      : heavy.map((s) => `${s.id}: ${weight(s)}`).join(", "),
  );
}

/* Emphasis markers must be balanced, or the split renders a stray asterisk on the slide. */
{
  const unbalanced = SLIDES.flatMap((s) =>
    [...(s.points ?? []), ...(s.standing ?? []), ...(s.gained ?? [])]
      .filter((p) => (p.match(/\*/g)?.length ?? 0) % 2 !== 0)
      .map(() => s.id),
  );
  check("emphasis markers are balanced", unbalanced.length === 0, unbalanced.length === 0 ? "every * is paired" : unbalanced.join(", "));
}

/*
 * NO STAGE DIRECTIONS ON A SLIDE. This deck's predecessor shipped bullets that described
 * what the camera was doing instead of saying anything — the audience read the choreography
 * and learned nothing. Presenter instructions belong in `note`, which never renders.
 */
{
  const DIRECTIONS = /\b(camera|zoom(s|es)? (in|out)|fade[s]? (in|out)|the (slide|screen) (then )?(shows|reveals)|cut to|we see)\b/i;
  const staged = SLIDES.flatMap((s) =>
    [s.lead ?? "", ...(s.points ?? []), ...(s.standing ?? []), ...(s.gained ?? [])]
      .filter((t) => DIRECTIONS.test(t))
      .map((t) => `${s.id}: "${t.slice(0, 60)}"`),
  );
  check("no stage directions in rendered copy", staged.length === 0, staged.length === 0 ? "clean across all slides" : staged.join("; "));
}

/* No placeholder may survive into a presented deck. */
{
  const stubs = SLIDES.flatMap((s) =>
    [s.title, s.lead ?? "", ...(s.points ?? []), ...(s.standing ?? []), ...(s.gained ?? [])]
      .filter((t) => /PLACEHOLDER|TODO|TBD|lorem/i.test(t))
      .map(() => s.id),
  );
  check("no placeholders remain", stubs.length === 0, stubs.length === 0 ? "none" : stubs.join(", "));
}

/*
 * NO SLIDE MAY STATE THE DECK'S OWN LENGTH.
 *
 * The how-to-read slide originally said "52 of them" and was wrong by one within the hour,
 * because adding that very slide changed the count it quoted. Any number in the copy that
 * describes the deck's own shape is a number that goes stale the next time the deck is
 * edited, and unlike every other figure here there is nothing upstream to catch it. The rail
 * already shows the real count, computed. So the copy must not.
 */
{
  const counts = new Set<string>();
  for (let n = SLIDES.length - 8; n <= SLIDES.length + 8; n += 1) counts.add(String(n));
  const offenders = SLIDES.flatMap((s) =>
    [s.lead ?? "", ...(s.points ?? []), ...(s.standing ?? []), ...(s.gained ?? [])]
      .filter((t) => /\bslides\b/i.test(t) && [...counts].some((n) => new RegExp(`\\b${n}\\b`).test(t)))
      .map((t) => `${s.id}: "${t.slice(0, 70)}"`),
  );
  check(
    "no slide quotes the deck's own length",
    offenders.length === 0,
    offenders.length === 0 ? "the rail is the only place the count appears" : offenders.join("; "),
  );
}

/* ------------------------------------------------------------------ the honest one */

/*
 * The bad validation number must still be on a slide, at its real value.
 *
 * This is a check on the argument rather than on the code, and it is here deliberately.
 * The easiest future edit to this deck is the one that quietly drops the 7.7 percent
 * coverage slide to make the presentation land better, and that edit would destroy the
 * thing act one was built to establish.
 */
{
  const bad = METRICS.find((m) => m.verdict === "bad");
  const onASlide = SLIDES.some((s) => s.id === "the-bad-one");
  const chipped = allPanelRefs().some((r) => r.kind === "metric" && r.id === bad?.id);
  check(
    "the worst number is still presented",
    Boolean(bad) && onASlide && chipped,
    bad ? `${bad.name} at ${bad.value}, on its own slide and behind a chip` : "no metric is marked bad — did the honesty go missing?",
  );
}

/* ------------------------------------------------------------------------- report */

console.log(results.join("\n"));
console.log(
  failures === 0
    ? `\nevery property holds — ${SLIDES.length} slides, ${ACTS.length} acts, ${allPanelRefs().length} panels`
    : `\n${failures} propert${failures === 1 ? "y" : "ies"} failed`,
);
process.exit(failures === 0 ? 0 : 1);
