import { useCallback, useEffect, useState } from "react";

import { api, reveal } from "./api.ts";
import { AdvisoryDetail } from "./components/AdvisoryDetail.tsx";
import { AdvisoryQueue } from "./components/AdvisoryQueue.tsx";
import { ControlBar } from "./components/ControlBar.tsx";
import type { ClockState } from "./components/ControlBar.tsx";
import { PlantSchematic } from "./components/PlantSchematic.tsx";
import { SummaryStrip } from "./components/SummaryStrip.tsx";
import { clampToEra, toIso } from "./lib/clock.ts";
import type {
  AdvisorySummary,
  AssetSummary,
  ClockRange,
  InjectedFault,
  SiteSummary,
} from "./types.ts";

/**
 * The operations screen.
 *
 * Three states, all of them explicit: loading, failed, and loaded. The failed state
 * carries the message and how to fix it, because the alternative — an empty table —
 * would read as "nothing is wrong with the building", which is the most dangerous
 * thing this screen could imply.
 */
export function App() {
  const [summary, setSummary] = useState<SiteSummary | null>(null);
  const [advisories, setAdvisories] = useState<AdvisorySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which advisory is open, or null for the queue. Held in state rather than in the
  // URL: adding a router for one nested view would be a dependency and a build step
  // for a screen with exactly two states. The cost is that the detail view is not
  // linkable, which is worth naming -- an operator cannot paste a colleague an
  // advisory. That is the first thing a router would buy.
  const [openId, setOpenId] = useState<string | null>(null);
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
      // Fetched together rather than in sequence: the strip and the queue are two
      // views of one queue and should never be rendered from different vintages.
      const [nextRange, nextAssets, downstream, key] = await Promise.all([
        api.eras(),
        api.assets(),
        // Zone names come from the graph traversal rather than being written into the
        // frontend, so a building with a sixth zone gets a sixth box with no code
        // change. Tolerated as optional: the schematic renders without zones.
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
          operations · one air handler, three chillers, three cooling towers
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
            written by <code>make advisories</code>.
          </div>
        </div>
      )}

      {!error && range && clock && (
        <ControlBar
          range={range}
          clock={clock}
          onChange={setClock}
          faults={faults}
        />
      )}

      {!error && openId !== null && (
        <AdvisoryDetail advisoryId={openId} onBack={() => setOpenId(null)} />
      )}

      {!error && openId === null && (
        <>
          {summary && <SummaryStrip summary={summary} />}
          {assets && advisories && (
            <PlantSchematic
              assets={assets}
              advisories={advisories}
              zones={zones}
              onSelectAsset={(assetId) => {
                // Clicking a machine opens its highest-priority advisory. The queue is
                // already in priority order, so the first match is that advisory, and
                // a component with nothing open simply does not respond.
                const first = advisories.find((a) => a.asset_id === assetId);
                if (first) setOpenId(first.advisory_id);
              }}
            />
          )}
          {advisories && (
            <AdvisoryQueue
              advisories={advisories}
              onSelect={(advisory) => setOpenId(advisory.advisory_id)}
            />
          )}
          {!advisories && <div className="muted">Loading the queue…</div>}
        </>
      )}
    </div>
  );
}
