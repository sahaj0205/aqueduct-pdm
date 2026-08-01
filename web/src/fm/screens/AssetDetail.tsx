import { Link, useNavigate, useParams } from "react-router-dom";

import { Panel } from "../../design/Panel.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ExpectedVsActual } from "../components/ExpectedVsActual.tsx";
import { HealthChart } from "../components/HealthChart.tsx";
import { HealthDot } from "../components/HealthDot.tsx";
import { ModeIndicators } from "../components/ModeIndicators.tsx";
import { RulFan } from "../components/RulFan.tsx";
import tableStyles from "../components/table.module.css";
import { getAssetDetail } from "../data/client.ts";
import { useData } from "../data/useData.ts";
import styles from "./AssetDetail.module.css";

export function AssetDetail() {
  const { assetId } = useParams<{ assetId: string }>();
  const navigate = useNavigate();
  const { data, loading, error } = useData(() => getAssetDetail(assetId!), [assetId]);

  if (!assetId) return <EmptyState title="No asset selected" />;
  if (loading) return <EmptyState title="Loading…" />;
  if (error || !data) return <EmptyState title="Could not load this asset">{error}</EmptyState>;

  const { asset, health, modes, residual, rul_history, advisories, points } = data;
  const openAdvisories = advisories.filter((a) => a.status === "open" || a.status === "scheduled");

  return (
    <div>
      <Link to="/fm/assets" style={{ color: "var(--ink-faint)", fontSize: 13, display: "inline-block", marginBottom: 16 }}>
        ← Back to assets
      </Link>

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{asset.name}</h1>
          <div className={styles.meta}>
            {asset.kind} · {asset.location} · in service since {asset.in_service}
          </div>
        </div>
        <HealthDot health={asset.health} band={asset.band} />
      </div>

      {openAdvisories.length > 0 && (
        <Panel title="Open advisories on this asset">
          {openAdvisories.map((a) => (
            <div key={a.advisory_id} className={styles.advisoryRow}>
              <Link className={styles.advisoryLink} to={`/fm/worklist/${a.advisory_id}`}>
                {a.fault_title}
              </Link>
              <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>
                {a.consequential ? "consequential" : `severity ${(a.severity * 100).toFixed(0)}%`}
              </span>
            </div>
          ))}
        </Panel>
      )}

      <div className={styles.grid}>
        <div>
          <Panel
            title="Health trend"
            sub={health.threshold_note}
            why="Raw is the unclamped indicator, kept so the clamp can be audited against what the instruments actually reported rather than taken on faith. Clamped is what the rest of the system acts on — health can only slide down between recorded repairs."
          >
            <HealthChart series={health} />
          </Panel>

          {residual && (
            <Panel title="Expected vs. actual" sub={`Baseline: ${residual.baseline}`}>
              <ExpectedVsActual series={residual} />
            </Panel>
          )}

          {rul_history.length > 1 && (
            <Panel title="Remaining-life estimate over time">
              <RulFan history={rul_history} />
            </Panel>
          )}
        </div>

        <div>
          <Panel title="Every way this machine can fail" sub="Health is the minimum across all of these.">
            <ModeIndicators modes={modes} />
          </Panel>

          <Panel title="Instruments on this machine" flush>
            <div className={tableStyles.wrap}>
              <div className={tableStyles.scroll}>
                <table className={tableStyles.table}>
                  <thead>
                    <tr>
                      <th>Point</th>
                      <th>Quality</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={p.point_id} onClick={() => navigate("/fm/instruments")} className={tableStyles.clickable}>
                        <td className={tableStyles.primary}>{p.label}</td>
                        <td className={tableStyles.num}>{p.score}</td>
                        <td className={tableStyles.faint}>{p.status.replace(/_/g, " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
