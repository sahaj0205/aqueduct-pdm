import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";

import { api, reveal } from "./api.ts";
import { AdvisoryDetail } from "./components/AdvisoryDetail.tsx";
import { ControlBar } from "./components/ControlBar.tsx";
import { Term } from "./design/Term.tsx";
import type { ClockState } from "./components/ControlBar.tsx";
import { NavTabs } from "./components/NavTabs.tsx";
import { clampToEra, toIso } from "./lib/clock.ts";
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

      {!error && <NavTabs />}

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
            path="/twin"
            element={
              <Twin at={clock ? toIso(clock.at) : null} advisories={advisories} />
            }
          />
          <Route
            path="/engine"
            element={
              <Engine at={clock ? toIso(clock.at) : null} twinState={twinState} />
            }
          />
          <Route
            path="/prediction"
            element={<Prediction at={clock ? toIso(clock.at) : null} />}
          />
          <Route path="/diagnosis" element={<Diagnosis />} />
          <Route
            path="/reveal"
            element={<Reveal at={clock ? toIso(clock.at) : null} />}
          />
          <Route path="/config" element={<Configuration />} />
          {/* An unknown path goes to the queue rather than to a blank screen. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </div>
  );
}
