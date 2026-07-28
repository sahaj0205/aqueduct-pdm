import { useNavigate } from "react-router-dom";

import { AdvisoryQueue } from "../components/AdvisoryQueue.tsx";
import { DigitalTwin } from "../components/DigitalTwin.tsx";
import { SummaryStrip } from "../components/SummaryStrip.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import { Term } from "../design/Term.tsx";
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

  // Live, never written into the string. The clock moves and this number moves with it;
  // a headline reading "six" above a queue showing two is worse than no headline.
  const open = summary?.advisories ?? null;

  /**
   * Machine id to human name, so the worst-health machine is named rather than coded.
   *
   * Built from two sources because neither alone is complete: the drawing knows every
   * machine in the building, and the queue knows every machine with an open job. The
   * worst-health machine can easily be one with no open job at all, which is exactly the
   * case a queue-only lookup would leave showing a raw identifier.
   */
  const assetNames: Record<string, string> = {};
  for (const node of topology?.nodes ?? []) {
    if (node.asset_id) assetNames[node.asset_id] = node.label;
  }
  for (const advisory of advisories ?? []) {
    assetNames[advisory.asset_id] ??= advisory.asset_name;
  }

  return (
    <>
      <ScreenHead
        sub={
          <>
            Each row is one repair somebody could be sent to do, ranked by what it saves
            against what it costs. You are looking at a <Term id="replay">replay</Term>:
            nothing the system worked out after the date on the clock appears anywhere on
            this page.
          </>
        }
        why={
          <>
            The order is decided upstream and is <strong>not</strong> re-sorted here. It
            is two tiers: everything that could be priced comes first, ranked on expected
            dollars saved per dollar spent; everything that could not be priced follows,
            ranked on severity. An unpriced job is not a cheap one — it is one nobody can
            put a number on yet, and hiding that distinction would be the easiest lie on
            this screen. A <Term id="consequential">consequential</Term> job is forced
            below whatever caused it, so fixing the cause makes it disappear on its own.
          </>
        }
      >
        {open === null
          ? "What needs doing"
          : open === 0
            ? "No machine needs work at this date."
            : `${open} maintenance job${open === 1 ? "" : "s"} ${open === 1 ? "is" : "are"} outstanding.`}
      </ScreenHead>

      {summary && <SummaryStrip summary={summary} assetNames={assetNames} />}
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
