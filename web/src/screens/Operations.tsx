import { useNavigate } from "react-router-dom";

import { AdvisoryQueue } from "../components/AdvisoryQueue.tsx";
import { DigitalTwin } from "../components/DigitalTwin.tsx";
import { SummaryStrip } from "../components/SummaryStrip.tsx";
import type {
  AdvisorySummary,
  SiteSummary,
  TwinState,
  TwinTopology,
} from "../types.ts";

/**
 * The operations screen: what is wrong with the building right now, ranked.
 *
 * Lifted out of App when the router arrived. App is now a shell — the clock, the
 * navigation and the error state — and every screen under it is a plain component
 * handed the data it needs. That split is what stops each new screen in Phase 1
 * growing its own copy of the clock.
 */

interface Props {
  summary: SiteSummary | null;
  advisories: AdvisorySummary[] | null;
  topology: TwinTopology | null;
  twinState: TwinState | null;
}

export function Operations({ summary, advisories, topology, twinState }: Props) {
  const navigate = useNavigate();

  return (
    <>
      {summary && <SummaryStrip summary={summary} />}
      {topology && advisories && (
        <DigitalTwin
          topology={topology}
          state={twinState}
          advisories={advisories}
          selected={null}
          onSelect={(nodeId) => {
            // On the operations screen a node click goes to that machine's
            // highest-priority advisory -- the queue is already in priority order, so
            // the first match is that advisory. The twin screen opens the instrument
            // list instead, which is the difference between the two screens.
            const node = topology.nodes.find((n) => n.node_id === nodeId);
            if (!node?.asset_id) return;
            const first = advisories.find((a) => a.asset_id === node.asset_id);
            if (first) navigate(`/advisory/${encodeURIComponent(first.advisory_id)}`);
          }}
        />
      )}
      {advisories && (
        <AdvisoryQueue
          advisories={advisories}
          onSelect={(advisory) =>
            navigate(`/advisory/${encodeURIComponent(advisory.advisory_id)}`)
          }
        />
      )}
      {!advisories && <div className="muted">Loading the queue…</div>}
    </>
  );
}
