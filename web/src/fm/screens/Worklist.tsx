import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Panel } from "../../design/Panel.tsx";
import { Picker } from "../../design/Picker.tsx";
import { ScreenHead } from "../../design/ScreenHead.tsx";
import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FaultClassTag } from "../components/Tags.tsx";
import { HealthDot } from "../components/HealthDot.tsx";
import { Horizon } from "../components/Horizon.tsx";
import tableStyles from "../components/table.module.css";
import { getHorizon, getInstruments, getWorklist } from "../data/client.ts";
import { reopenAdvisory } from "../data/mutations.ts";
import { useData } from "../data/useData.ts";
import { plural, ratio, relativeSince, relativeToNow, usd } from "../lib/format.ts";
import type { AdvisoryRow, WorklistOrder } from "../types.ts";
import styles from "./Worklist.module.css";

export function Worklist() {
  const [order, setOrder] = useState<WorklistOrder>("priority");
  const { data, loading, error } = useData(() => getWorklist(order), [order]);
  const { data: instruments } = useData(getInstruments);
  const { data: horizon } = useData(getHorizon);
  const navigate = useNavigate();

  const total = (data?.priced.length ?? 0) + (data?.unpriced.length ?? 0);

  return (
    <div>
      <ScreenHead
        sub={
          total > 0
            ? `${plural(total, "machine")} need attention right now.`
            : "Nothing needs attention right now."
        }
        why="Priced rows are ranked by expected dollars saved per dollar spent — the same figure shown in the Priority column. Unpriced rows have no computable cost of waiting, so they are ranked by severity instead and kept in a separate tier rather than shown as $0.00, which would claim the fault is free to ignore."
      >
        {total > 0 ? `${total} machines need attention` : "The worklist is clear"}
      </ScreenHead>

      {horizon && (
        <Panel
          title="Failure horizon"
          sub={`Next ${horizon.horizon_days} days, every open estimate on one axis.`}
          why="Each band is the published 10th–90th percentile remaining-life window for that advisory — the same range shown on its own page, laid out for comparison instead of read one at a time. The tick is the most likely date. A refused prediction never gets a band; it's listed below instead."
        >
          <Horizon data={horizon} />
        </Panel>
      )}

      <Panel
        title="Open advisories"
        action={
          <Picker
            label="Order by"
            value={order}
            onChange={setOrder}
            options={[
              { id: "priority", label: "Return on action" },
              { id: "deadline", label: "Deadline" },
            ]}
          />
        }
        flush
      >
        {loading && <EmptyState title="Loading the worklist…" />}
        {error && <EmptyState title="Could not load the worklist">{error}</EmptyState>}
        {data && total === 0 && (
          <EmptyState title="Nothing needs attention" good>
            Every tracked asset is inside its healthy band and every open item has been actioned.
          </EmptyState>
        )}
        {data && total > 0 && (
          <div className={tableStyles.wrap}>
            <div className={tableStyles.scroll}>
              <table className={tableStyles.table}>
                <thead>
                  <tr>
                    <th>Machine / fault</th>
                    <th>Class</th>
                    <th>Health</th>
                    <th>Confidence</th>
                    <th>Act by</th>
                    <th>Waiting costs</th>
                    <th>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {data.priced.map((row) => (
                    <Row key={row.advisory_id} row={row} onOpen={() => navigate(`/fm/worklist/${row.advisory_id}`)} />
                  ))}
                  {data.unpriced.length > 0 && (
                    <tr className={tableStyles.tierDivider}>
                      <td colSpan={7}>{data.unpriced_note}</td>
                    </tr>
                  )}
                  {data.unpriced.map((row) => (
                    <Row key={row.advisory_id} row={row} onOpen={() => navigate(`/fm/worklist/${row.advisory_id}`)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      {instruments && instruments.advisories.length > 0 && (
        <Panel
          title="Instrument advisories"
          sub="A calibration kit or a wrench — dispatched as its own decision, before a repair job is chosen."
        >
          {instruments.advisories.map((s) => (
            <div key={s.advisory_id} className={styles.sensorRow}>
              <div className={styles.sensorMain}>
                <span className={styles.sensorLabel}>
                  {s.asset_name} — {s.label}
                </span>
                <span className={styles.sensorVerdict}>{s.verdict}</span>
              </div>
              <a className={styles.link} href="/fm/instruments">
                Review →
              </a>
            </div>
          ))}
        </Panel>
      )}

      {data && data.recently_dismissed.length > 0 && (
        <Panel title="Recently dismissed" sub="Closing the loop on a dismissal is what makes it safe to trust the next one." bare>
          <div className={styles.dismissedPanel}>
            {data.recently_dismissed.map((row) => (
              <div key={row.advisory_id} className={styles.dismissedRow}>
                <div>
                  <span>{row.asset_name} — {row.fault_title}</span>
                  <div className={styles.dismissedMeta}>
                    Dismissed {relativeSince(row.dismissed_at)} · {row.dismissed_note}
                  </div>
                </div>
                <Button size="sm" onClick={() => reopenAdvisory(row.advisory_id)}>
                  Reopen
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function Row({ row, onOpen }: { row: AdvisoryRow; onOpen: () => void }) {
  return (
    <>
      <tr className={tableStyles.clickable} onClick={onOpen}>
        <RowCells row={row} />
      </tr>
      {row.children.map((child) => (
        <tr key={child.advisory_id} className={tableStyles.childRow}>
          <RowCells row={child} indented />
        </tr>
      ))}
    </>
  );
}

function RowCells({ row, indented = false }: { row: AdvisoryRow; indented?: boolean }) {
  return (
    <>
      <td>
        <div className={styles.rowMain}>
          <div className={styles.faultLine}>
            <span className={tableStyles.primary}>
              {indented ? "↳ " : ""}
              {row.asset_name}
            </span>{" "}
            <span>— {row.fault_title}</span>
          </div>
          {row.consequential && (
            <span className={styles.consequentialNote}>
              Consequential — expected to clear when {row.cause_asset_name} is fixed
            </span>
          )}
        </div>
      </td>
      <td>
        <FaultClassTag value={row.fault_class} />
      </td>
      <td>
        <HealthDot health={row.health} band={row.band} />
      </td>
      <td className={tableStyles.faint}>
        {/* Confidence is band width plus evidence. With no published estimate there is
            neither, and "0 d evidence" would read as a measurement rather than as an
            absence — so the cell says nothing was published instead. */}
        {row.band_width_days !== null
          ? `± ${Math.round(row.band_width_days / 2)} d (${row.evidence_days} d evidence)`
          : "no estimate published"}
      </td>
      <td className={tableStyles.num}>{row.act_by ? relativeToNow(row.act_by) : "no estimate"}</td>
      <td className={tableStyles.num}>{row.cost_of_waiting_usd !== null ? usd(row.cost_of_waiting_usd) : "unpriced"}</td>
      <td className={tableStyles.num}>{ratio(row.priority)}</td>
    </>
  );
}
