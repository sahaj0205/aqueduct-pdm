import { Panel } from "../../design/Panel.tsx";
import { ScreenHead } from "../../design/ScreenHead.tsx";
import { Stat, StatRow } from "../../design/Stat.tsx";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import tableStyles from "../components/table.module.css";
import { useToast } from "../components/Toast.tsx";
import { getInstruments } from "../data/client.ts";
import { acknowledgeSensorAdvisory } from "../data/mutations.ts";
import { useData } from "../data/useData.ts";
import { relativeSince, usd } from "../lib/format.ts";
import styles from "./Instruments.module.css";

export function Instruments() {
  const { data, loading, error } = useData(getInstruments);
  const toast = useToast();

  return (
    <div>
      <ScreenHead
        sub="Silence must not read as health. Every prediction on this system depends on the instruments it stands on."
        why="Each point's score is the worst of five checks — timeliness, completeness, range, plausibility, staleness — never the average, so one failing check cannot be diluted by four passing ones. Defective-at-source points are wired or ranged wrong since installation and carry a written reason; they are excluded from every downstream calculation, not silently trusted."
      >
        Instrument health
      </ScreenHead>

      {loading && <EmptyState title="Loading instruments…" />}
      {error && <EmptyState title="Could not load instruments">{error}</EmptyState>}

      {data && (
        <>
          <Panel title="Coverage">
            <StatRow>
              <Stat label="Points tracked" value={data.coverage.points_total} />
              <Stat label="Assets covered" value={`${data.coverage.assets_covered}/${data.coverage.assets_total}`} />
              <Stat label="OK" value={data.coverage.ok} tone="good" />
              <Stat label="Watch" value={data.coverage.watch} tone="caution" />
              <Stat label="Bad" value={data.coverage.bad} tone="alarm" />
              <Stat label="Defective at source" value={data.coverage.defective_at_source} tone="alarm" />
            </StatRow>
          </Panel>

          {data.advisories.length > 0 && (
            <Panel title="Sensor advisories" sub="Dispatched as a calibration-kit decision, before any repair job is chosen.">
              {data.advisories.map((s) => (
                <div key={s.advisory_id} className={styles.advisoryCard}>
                  <div className={styles.advisoryTop}>
                    <span className={styles.advisoryTitle}>
                      {s.asset_name} — {s.label}
                    </span>
                    <span className={styles.advisoryMeta}>since {relativeSince(s.since)}</span>
                  </div>
                  <p>{s.verdict}</p>
                  <p className={styles.advisoryMeta}>{s.recommended}</p>
                  {s.blocks.length > 0 && (
                    <p className={styles.blocks}>Blocks: {s.blocks.join(", ")}</p>
                  )}
                  <div className={styles.advisoryMeta}>Diagnostic cost: {s.hours} h, {usd(s.cost_usd)}</div>
                  {s.status === "open" ? (
                    <Button
                      size="sm"
                      className={styles.ackBtn}
                      onClick={async () => {
                        await acknowledgeSensorAdvisory(s.advisory_id);
                        toast(`Acknowledged — ${s.asset_name} ${s.label}`);
                      }}
                    >
                      Acknowledge, technician dispatched
                    </Button>
                  ) : (
                    <span className={styles.advisoryMeta}>Acknowledged</span>
                  )}
                </div>
              ))}
            </Panel>
          )}

          <Panel title="Every tracked point" flush>
            <div className={tableStyles.wrap}>
              <div className={tableStyles.scroll}>
                <table className={tableStyles.table}>
                  <thead>
                    <tr>
                      <th>Point</th>
                      <th>Asset</th>
                      <th>Score</th>
                      <th>Worst check</th>
                      <th>Status</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.points.map((p) => (
                      <tr key={p.point_id}>
                        <td className={tableStyles.primary}>{p.label}</td>
                        <td className={tableStyles.faint}>{p.asset_name}</td>
                        <td className={tableStyles.num}>{p.score}</td>
                        <td className={tableStyles.faint}>{p.worst_check}</td>
                        <td className={tableStyles.faint}>{p.status.replace(/_/g, " ")}</td>
                        <td className={tableStyles.faint} style={{ maxWidth: 320 }}>
                          {p.note ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
