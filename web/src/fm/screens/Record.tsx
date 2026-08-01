import { Panel } from "../../design/Panel.tsx";
import { ScreenHead } from "../../design/ScreenHead.tsx";
import { Stat, StatRow } from "../../design/Stat.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import tableStyles from "../components/table.module.css";
import { getFieldRecord } from "../data/client.ts";
import { useData } from "../data/useData.ts";
import { date, num, pct, usd } from "../lib/format.ts";
import type { RecordOutcome } from "../types.ts";

const OUTCOME_LABEL: Record<RecordOutcome, string> = {
  confirmed: "Confirmed",
  not_found: "Not found",
  dismissed_then_failed: "Dismissed, then failed",
  in_progress: "In progress",
  open: "Open",
};

export function Record() {
  const { data, loading, error } = useData(getFieldRecord);

  return (
    <div>
      <ScreenHead
        sub="What earns the next year's budget: not just what the system predicted, but what actually happened."
        why="Avoided cost is counted only for closed jobs where health was observed to recover afterward — never a modelled or assumed figure. Dismissed-then-failed entries are the sharpest credibility instrument here: shown honestly, not filtered out, because a track record that hides its misses cannot be trusted for its hits either."
      >
        Track record
      </ScreenHead>

      {loading && <EmptyState title="Loading the field record…" />}
      {error && <EmptyState title="Could not load the field record">{error}</EmptyState>}

      {data && (
        <>
          <Panel
            title="Since the system went live"
            why="Hit rate is confirmed ÷ (confirmed + not found) — only advisories a technician actually went and checked count, since those are the only cases where we know whether the system was right. Still-open cases haven't been verified yet, and a dismissal is a separate judgement call, not a miss on the original detection — neither belongs in this denominator."
          >
            <StatRow>
              <Stat label="Raised" value={num(data.raised)} />
              <Stat label="Confirmed" value={num(data.confirmed)} tone="good" />
              <Stat label="Not found" value={num(data.not_found)} />
              <Stat label="Dismissed, then failed" value={num(data.dismissed_then_failed)} tone={data.dismissed_then_failed > 0 ? "alarm" : "neutral"} />
              <Stat label="Still open" value={num(data.open)} />
              <Stat
                label="Verified hit rate"
                value={data.hit_rate !== null ? pct(data.hit_rate) : "—"}
                caption={data.verified_n > 0 ? `n=${data.verified_n} verified in the field` : "No verified cases yet"}
                tone={data.hit_rate !== null && data.hit_rate >= 0.7 ? "good" : "neutral"}
              />
            </StatRow>
          </Panel>

          <Panel title="Spend and avoided cost">
            <StatRow>
              <Stat label="Spent on repairs" value={usd(data.spend_usd)} />
              <Stat label="Avoided cost" value={usd(data.avoided_usd)} tone="good" caption={data.avoided_basis} />
            </StatRow>
          </Panel>

          <Panel title="Every entry" flush>
            <div className={tableStyles.wrap}>
              <div className={tableStyles.scroll}>
                <table className={tableStyles.table}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Fault</th>
                      <th>Raised</th>
                      <th>Outcome</th>
                      <th>Found</th>
                      <th>Health</th>
                      <th>Spend</th>
                      <th>Avoided</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((e) => (
                      <tr key={e.advisory_id}>
                        <td className={tableStyles.primary}>{e.asset_name}</td>
                        <td className={tableStyles.faint}>{e.fault_title}</td>
                        <td className={tableStyles.faint}>{date(e.raised)}</td>
                        <td className={tableStyles.faint}>{OUTCOME_LABEL[e.outcome]}</td>
                        <td className={tableStyles.faint} style={{ maxWidth: 320 }}>
                          {e.found ?? e.dismissed_reason ?? "—"}
                        </td>
                        <td className={tableStyles.num}>
                          {e.health_before ?? "—"} → {e.health_after ?? "—"}
                          {e.recovered === true && " ✓"}
                        </td>
                        <td className={tableStyles.num}>{e.spend_usd !== null ? usd(e.spend_usd) : "—"}</td>
                        <td className={tableStyles.num}>{e.avoided_usd !== null ? usd(e.avoided_usd) : "—"}</td>
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
