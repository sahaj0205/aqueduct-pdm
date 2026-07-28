import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";

import { api, reveal } from "./api.ts";
import { AdvisoryDetail } from "./components/AdvisoryDetail.tsx";
import { ControlBar } from "./components/ControlBar.tsx";
import { Term } from "./design/Term.tsx";
import type { ClockState } from "./components/ControlBar.tsx";
import { NavTabs } from "./components/NavTabs.tsx";
import { Walkthrough } from "./components/Walkthrough.tsx";
import { clampToEra, toIso } from "./lib/clock.ts";
import { buildTour } from "./lib/tour.ts";
import { Diagnosis } from "./screens/Diagnosis.tsx";
import { Engine } from "./screens/Engine.tsx";
import { Operations } from "./screens/Operations.tsx";
import { Configuration } from "./screens/Configuration.tsx";
import { Prediction } from "./screens/Prediction.tsx";
import { Reveal } from "./screens/Reveal.tsx";
import { Twin } from "./screens/Twin.tsx";
import type {
  AdvisorySummary,
  ClockRange,
  InjectedFault,
  SiteSummary,
  TwinState,
  TwinTopology,
} from "./types.ts";

/**
 * The shell: the clock, the navigation, the error state, and everything the screens
 * share. Each screen is a plain component below it.
 *
 * WHY THE CLOCK LIVES HERE AND NOT IN A SCREEN. Every screen shows one moment and they
 * must all show the SAME moment. Held in the shell, the clock survives navigation —
 * open an advisory and come back and the day has not jumped — and no screen can grow
 * its own copy.
 *
 * Three states, all of them explicit: loading, failed, and loaded. The failed state
 * carries the message and how to fix it, because the alternative — an empty table —
 * would read as "nothing is wrong with the building", which is the most dangerous
 * thing this dashboard could imply.
 */

/**
 * Where each screen used to live, and where it lives now.
 *
 * The paths were renamed alongside the tabs, because a URL is read aloud in a
 * demonstration and shown in the address bar of a shared screen, and "/engine" tells a
 * viewer as little there as it did on the tab. Old paths redirect rather than 404: this
 * build is already deployed, and a link somebody saved last week should still land.
 *
 * THE COMPONENT FILES WERE NOT RENAMED. `screens/Engine.tsx` still renders "How we
 * know". Renaming seven files and their imports would be a large diff with no visible
 * effect whatever, so the correspondence is written down here instead — this table is
 * the one place that maps the internal name to the name a viewer sees.
 */
const MOVED: Record<string, string> = {
  "/twin": "/building", //            Twin.tsx          → The building
  "/engine": "/how-we-know", //       Engine.tsx        → How we know
  "/diagnosis": "/sensor-or-machine", // Diagnosis.tsx  → Sensor or machine
  "/prediction": "/time-left", //     Prediction.tsx    → Time left
  "/config": "/rules", //             Configuration.tsx → The rules
  "/reveal": "/answer", //            Reveal.tsx        → The answer
};

/** The advisory detail, reading its id from the URL rather than from a state flag. */
function AdvisoryRoute() {
  const { advisoryId } = useParams<{ advisoryId: string }>();
  const navigate = useNavigate();
  if (!advisoryId) return <Navigate to="/" replace />;
  return <AdvisoryDetail advisoryId={advisoryId} onBack={() => navigate("/")} />;
}

export function App() {
  const [summary, setSummary] = useState<SiteSummary | null>(null);
  const [advisories, setAdvisories] = useState<AdvisorySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [topology, setTopology] = useState<TwinTopology | null>(null);
  const [twinState, setTwinState] = useState<TwinState | null>(null);

  // The clock. One position, shared by every screen, so the queue and the building
  // drawing can never disagree about what day it is. Null until the range is known --
  // there is no sensible default moment in a database holding four runs placed years
  // apart, and guessing one would land the dashboard in an empty stretch of calendar.
  const [range, setRange] = useState<ClockRange | null>(null);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [faults, setFaults] = useState<InjectedFault[] | null>(null);

  /**
   * Guided or self-directed, and which step of the guide.
   *
   * STARTS GUIDED, and that is the point of the mode existing. Seven screens of equal
   * weight is exactly the confusion this phase set out to remove, and somebody opening
   * this for the first time has no way to know which tab answers their question.
   *
   * The choice is remembered for the session, so anybody who leaves the tour once is not
   * put back into it on every reload — which is what makes starting guided tolerable for
   * the person building the thing rather than merely correct for the person being shown
   * it. Session rather than permanent storage, so a fresh window is a fresh audience.
   */
  const [guided, setGuided] = useState(
    () => sessionStorage.getItem("aqueduct.explore") !== "1",
  );
  const [step, setStep] = useState(0);

  const leaveTour = useCallback(() => {
    sessionStorage.setItem("aqueduct.explore", "1");
    setGuided(false);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextRange, nextTopology, key] = await Promise.all([
        api.eras(),
        // The shape of the building, fetched once. Every node, every relation and every
        // instrument comes from the semantic model rather than being written into the
        // frontend, so a building with a sixth zone gets a sixth box with no code change.
        api.twinTopology(),
        // The answer key is optional and its absence is not an error: the reveal
        // service is a separate process and the dashboard is fully usable without it.
        reveal.scenarios(),
      ]);
      setRange(nextRange);
      setTopology(nextTopology);
      setFaults(key?.faults ?? null);
      // Start at the end of the first run rather than its beginning. A run opens with
      // three weeks of healthy commissioning data, so a dashboard that started there
      // would open on an empty queue and look broken; the end of the run is where
      // there is something to see, and the clock can be dragged backwards.
      // An empty era list is not possible from a database with health history -- the
      // endpoint 404s rather than returning one -- but it is checked instead of
      // asserted, because the alternative is a crash on an index that reads as a
      // frontend bug rather than as an empty database.
      const first = nextRange.eras[0];
      if (first) {
        setClock((current) =>
          current ?? {
            at: clampToEra(nextRange, new Date(first.t_to)),
            playing: false,
            speed: 1,
          },
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Derived, never written down. Every moment the tour stops at comes from the run list
  // the API returned, refined by the answer key only when the reveal service is running —
  // see lib/tour.ts for why a tour with dates typed into it would fail silently.
  const tour = useMemo(
    () => (range ? buildTour(range, faults) : []),
    [range, faults],
  );

  // Everything the clock drives is refetched when it moves. Kept separate from the
  // load above so that dragging the scrubber does not refetch the topology, the asset
  // list or the answer key, none of which depend on the moment.
  useEffect(() => {
    if (!clock) return;
    const at = toIso(clock.at);
    let cancelled = false;
    void (async () => {
      try {
        const [nextSummary, nextAdvisories, nextTwinState] = await Promise.all([
          api.summary(at),
          api.advisories("open", at),
          api.twinState(at),
        ]);
        if (cancelled) return;
        setSummary(nextSummary);
        setAdvisories(nextAdvisories);
        setTwinState(nextTwinState);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clock]);

  return (
    <div className="page">
      {/* The vocabulary layer, working. Three domain words in the one line that
          describes the building, each carrying its own definition — where before this
          checkpoint a reader who did not know what a cooling tower was had nowhere to
          find out without leaving the page. */}
      <header className="masthead">
        <h1>Aqueduct PDM</h1>
        <span className="sub">
          one <Term id="air-handler">air handler</Term>, three{" "}
          <Term id="chiller">chillers</Term>, three{" "}
          <Term id="cooling-tower">cooling towers</Term>
        </span>
      </header>

      {error && (
        <div className="notice">
          <strong>The API did not answer.</strong>
          <p className="muted">{error}</p>
          <p className="muted">
            Start it with <code>make api</code>, then reload. The queue itself is
            written by <code>make advisory-replay</code>.
          </p>
        </div>
      )}

      {!error && range && clock && (
        <ControlBar range={range} clock={clock} onChange={setClock} faults={faults} />
      )}

      {/* The tour and the tabs occupy the same place, so switching between them does not
          reshape the page under the viewer. The tour is only offered once the run list
          has arrived, because every step it takes is derived from that list. */}
      {!error &&
        (guided && tour.length > 0 ? (
          <Walkthrough
            steps={tour}
            index={step}
            onIndex={setStep}
            onExit={leaveTour}
            onMoment={(at) =>
              setClock((current) =>
                current ? { ...current, at, playing: false } : current,
              )
            }
          />
        ) : (
          <NavTabs
            onStartTour={
              tour.length > 0
                ? () => {
                    setStep(0);
                    setGuided(true);
                  }
                : undefined
            }
          />
        ))}

      {!error && (
        <Routes>
          <Route
            path="/"
            element={
              <Operations
                summary={summary}
                advisories={advisories}
                topology={topology}
                twinState={twinState}
              />
            }
          />
          <Route path="/advisory/:advisoryId" element={<AdvisoryRoute />} />
          <Route
            path="/building"
            element={
              <Twin at={clock ? toIso(clock.at) : null} advisories={advisories} />
            }
          />
          <Route
            path="/how-we-know"
            element={
              <Engine at={clock ? toIso(clock.at) : null} twinState={twinState} />
            }
          />
          <Route path="/sensor-or-machine" element={<Diagnosis />} />
          <Route
            path="/time-left"
            element={<Prediction at={clock ? toIso(clock.at) : null} />}
          />
          <Route path="/rules" element={<Configuration />} />
          <Route
            path="/answer"
            element={<Reveal at={clock ? toIso(clock.at) : null} />}
          />

          {/* Anything that used to be a tab still lands where it moved to. */}
          {Object.entries(MOVED).map(([from, to]) => (
            <Route key={from} path={from} element={<Navigate to={to} replace />} />
          ))}

          {/* An unknown path goes to the queue rather than to a blank screen. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </div>
  );
}
