import { useCallback, useEffect, useState } from "react";

import { api } from "./api.ts";
import { AdvisoryDetail } from "./components/AdvisoryDetail.tsx";
import { AdvisoryQueue } from "./components/AdvisoryQueue.tsx";
import { SummaryStrip } from "./components/SummaryStrip.tsx";
import type { AdvisorySummary, SiteSummary } from "./types.ts";

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

  const load = useCallback(async () => {
    setError(null);
    try {
      // Fetched together rather than in sequence: the strip and the queue are two
      // views of one queue and should never be rendered from different vintages.
      const [nextSummary, nextAdvisories] = await Promise.all([
        api.summary(),
        api.advisories("open"),
      ]);
      setSummary(nextSummary);
      setAdvisories(nextAdvisories);
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
