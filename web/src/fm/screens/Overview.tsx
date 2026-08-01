import { Link } from "react-router-dom";

import { Panel } from "../../design/Panel.tsx";
import { ScreenHead } from "../../design/ScreenHead.tsx";
import { Stat, StatRow } from "../../design/Stat.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { PlantMap } from "../components/PlantMap.tsx";
import { getOverview, getTopology } from "../data/client.ts";
import { useData } from "../data/useData.ts";
import { BAND_LABEL, kwh, num, plural, usdPerDay } from "../lib/format.ts";
import type { HealthBand } from "../types.ts";
import styles from "./Overview.module.css";

const BAND_ORDER: HealthBand[] = ["critical", "degraded", "watch", "healthy"];
const BAND_VAR: Record<HealthBand, string> = {
  healthy: "var(--health-healthy)",
  watch: "var(--health-watch)",
  degraded: "var(--health-degraded)",
  critical: "var(--health-critical)",
};

export function Overview() {
  const { data: overview, loading, error } = useData(getOverview);
  const { data: topology } = useData(getTopology);

  return (
    <div>
      <ScreenHead
        sub="Everything below answers one question: is anything wrong, and how bad."
        why="Buckets come straight from each asset's health score — 85+ healthy, 70–84 watch, 50–69 degraded, under 50 critical. Attributable waste sums only the energy term of open advisories' cost-of-waiting, divided over the horizon; it is not total building energy use."
      >
        {overview
          ? overview.open_total > 0
            ? `${plural(overview.open_total, "machine")} need attention`
            : "Nothing needs attention right now"
          : "Loading…"}
      </ScreenHead>

      {loading && <EmptyState title="Loading the building…" />}
      {error && <EmptyState title="Could not load the overview">{error}</EmptyState>}

      {overview && (
        <>
          <div className={styles.buckets}>
            {BAND_ORDER.map((band) => (
              <div key={band} className={styles.bucket} style={{ borderLeft: `3px solid ${BAND_VAR[band]}` }}>
                <span className={styles.bucketCount} style={{ color: BAND_VAR[band] }}>
                  {overview.buckets[band]}
                </span>
                <span className={styles.bucketLabel}>{BAND_LABEL[band]}</span>
              </div>
            ))}
            {overview.unscored > 0 && (
              <div className={styles.bucket} style={{ borderLeft: "3px solid var(--hairline-strong)" }}>
                <span className={styles.bucketCount} style={{ color: "var(--ink-faint)" }}>
                  {overview.unscored}
                </span>
                <span className={styles.bucketLabel}>Not scored</span>
              </div>
            )}
          </div>
          {overview.unscored > 0 && (
            <p className={styles.bucketNote}>
              {overview.unscored} of {overview.assets_total} assets have no failure mode scored in this
              run, so they sit in no band. That is a gap in coverage, not a clean bill of health.
            </p>
          )}

          <div className={styles.tiles}>
            <Panel>
              <Stat
                label="Attributable waste"
                value={usdPerDay(overview.attributable_waste.usd_per_day)}
                caption={`${kwh(overview.attributable_waste.kwh_per_day)}/day burned by faults already open`}
              />
            </Panel>
            <Panel>
              <Stat
                label="Blind spots"
                value={overview.blind_spots.stale + overview.blind_spots.defective_at_source}
                caption={`${overview.blind_spots.stale} instruments gone stale, ${overview.blind_spots.defective_at_source} defective at source — out of ${overview.blind_spots.points_total}`}
                tone={overview.blind_spots.stale + overview.blind_spots.defective_at_source > 0 ? "caution" : "neutral"}
              />
            </Panel>
            <Panel>
              <Stat
                label="Unpriced advisories"
                value={overview.unpriced_total}
                caption="No cost of waiting could be computed — ranked on severity instead"
              />
            </Panel>
          </div>

          <Panel title="Since yesterday" sub="What changed in the last 24 hours">
            <StatRow>
              <Stat label="New advisories" value={overview.changes.new_advisories} />
              <Stat label="Newly predicted" value={overview.changes.newly_predicted} caption="Crossed the 21-day evidence gate" />
              <Stat label="Resolved" value={overview.changes.resolved} tone="good" />
            </StatRow>
          </Panel>

          {overview.worst && (
            <Panel title="Worst-performing asset">
              <p>
                <Link to={`/fm/assets/${overview.worst.asset_id}`} style={{ color: "var(--primary)", fontWeight: 500 }}>
                  {overview.worst.asset_name}
                </Link>{" "}
                is at health {num(overview.worst.health)} — {overview.worst.mode_label.toLowerCase()}.
              </p>
            </Panel>
          )}

          {topology && (
            <Panel
              title="The plant"
              sub="Cooling towers → chilled water plant → chillers → air handler. A line means what one machine does affects the next."
            >
              <PlantMap topology={topology} />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
