import { useCallback, useEffect, useState } from "react";

import { api } from "./api.ts";
import { AdvisoryDetail } from "./components/AdvisoryDetail.tsx";
import { AdvisoryQueue } from "./components/AdvisoryQueue.tsx";
import { PlantSchematic } from "./components/PlantSchematic.tsx";
import { SummaryStrip } from "./components/SummaryStrip.tsx";
import type { AdvisorySummary, AssetSummary, SiteSummary } from "./types.ts";

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

  const load = useCallback(async () => {
    setError(null);
    try {
      // Fetched together rather than in sequence: the strip and the queue are two
      // views of one queue and should never be rendered from different vintages.
      const [nextSummary, nextAdvisories, nextAssets, downstream] = await Promise.all([
        api.summary(),
        api.advisories("open"),
        api.assets(),
        // Zone names come from the graph traversal rather than being written into the
        // frontend, so a building with a sixth zone gets a sixth box with no code
        // change. Tolerated as optional: the schematic renders without zones.
        api.downstream("ahu-1").catch(() => null),
      ]);
      setSummary(nextSummary);
      setAdvisories(nextAdvisories);
      setAssets(nextAssets);
      setZones(downstream?.zones ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
