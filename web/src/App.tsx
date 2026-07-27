import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";

import { api, reveal } from "./api.ts";
import { AdvisoryDetail } from "./components/AdvisoryDetail.tsx";
import { ControlBar } from "./components/ControlBar.tsx";
import type { ClockState } from "./components/ControlBar.tsx";
import { NavTabs } from "./components/NavTabs.tsx";
import { clampToEra, toIso } from "./lib/clock.ts";
import { Operations } from "./screens/Operations.tsx";
import type {
  AdvisorySummary,
  AssetSummary,
  ClockRange,
  InjectedFault,
  SiteSummary,
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

function NotBuilt({ name }: { name: string }) {
  return (
    <div className="notice">
      <strong>{name} is not built yet.</strong>
      <div className="muted" style={{ marginTop: 6 }}>
        The route exists so the shape of the dashboard is visible from the first
        screen. See ROADMAP.md for the order these arrive in.
      </div>
    </div>
  );
}

export function App() {
  const [summary, setSummary] = useState<SiteSummary | null>(null);
  const [advisories, setAdvisories] = useState<AdvisorySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [zones, setZones] = useState<string[]>([]);

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
      const [nextRange, nextAssets, downstream, key] = await Promise.all([
        api.eras(),
        api.assets(),
        // Zone names come from the graph traversal rather than being written into the
        // frontend, so a building with a sixth zone gets a sixth box with no code
        // change. Tolerated as optional: the drawing renders without zones.
        api.downstream("ahu-1").catch(() => null),
        // The answer key is optional and its absence is not an error: the reveal
        // service is a separate process and the dashboard is fully usable without it.
        reveal.scenarios(),
      ]);
      setRange(nextRange);
      setAssets(nextAssets);
      setZones(downstream?.zones ?? []);
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
        const [nextSummary, nextAdvisories] = await Promise.all([
          api.summary(at),
          api.advisories("open", at),
        ]);
        if (cancelled) return;
        setSummary(nextSummary);
        setAdvisories(nextAdvisories);
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
      <header className="masthead">
        <h1>Aqueduct PDM</h1>
        <span className="sub">
          one air handler, three chillers, three cooling towers
        </span>
      </header>

      {error && (
        <div className="notice">
          <strong>The API did not answer.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Start it with <code>make api</code>, then reload. The queue itself is
            written by <code>make advisory-replay</code>.
          </div>
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
                assets={assets}
                zones={zones}
              />
            }
          />
          <Route path="/advisory/:advisoryId" element={<AdvisoryRoute />} />
          <Route path="/twin" element={<NotBuilt name="The digital twin" />} />
          <Route path="/engine" element={<NotBuilt name="The engine trace" />} />
          <Route
            path="/prediction"
            element={<NotBuilt name="Prediction versus truth" />}
          />
          <Route path="/reveal" element={<NotBuilt name="The reveal" />} />
          <Route path="/config" element={<NotBuilt name="Configuration" />} />
          {/* An unknown path goes to the queue rather than to a blank screen. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </div>
  );
}
