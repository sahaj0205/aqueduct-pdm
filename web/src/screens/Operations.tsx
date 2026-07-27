import { useNavigate } from "react-router-dom";

import { AdvisoryQueue } from "../components/AdvisoryQueue.tsx";
import { PlantSchematic } from "../components/PlantSchematic.tsx";
import { SummaryStrip } from "../components/SummaryStrip.tsx";
import type { AdvisorySummary, AssetSummary, SiteSummary } from "../types.ts";

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
  assets: AssetSummary[] | null;
  zones: string[];
}

export function Operations({ summary, advisories, assets, zones }: Props) {
  const navigate = useNavigate();

  return (
    <>
      {summary && <SummaryStrip summary={summary} />}
      {assets && advisories && (
        <PlantSchematic
          assets={assets}
          advisories={advisories}
          zones={zones}
          onSelectAsset={(assetId) => {
            // Clicking a machine opens its highest-priority advisory. The queue is
            // already in priority order, so the first match is that advisory, and a
            // component with nothing open simply does not respond.
            const first = advisories.find((a) => a.asset_id === assetId);
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
