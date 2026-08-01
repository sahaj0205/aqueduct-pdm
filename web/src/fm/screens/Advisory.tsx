import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Panel } from "../../design/Panel.tsx";
import { SeverityBadge } from "../../design/SeverityBadge.tsx";
import { Button } from "../components/Button.tsx";
import { Drawer } from "../components/Drawer.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FaultClassTag, ProvenanceTag } from "../components/Tags.tsx";
import { RefusalCard } from "../components/RefusalCard.tsx";
import { RulFan } from "../components/RulFan.tsx";
import { useToast } from "../components/Toast.tsx";
import { getAdvisoryDetail, getRulHistory } from "../data/client.ts";
import { dismissAdvisory, raiseWorkOrder, recordRepair } from "../data/mutations.ts";
import { useData } from "../data/useData.ts";
import { date, dateShort, num, ratio, tierOfBand, usd } from "../lib/format.ts";
import type { DismissReason } from "../types.ts";
import styles from "./Advisory.module.css";

export function Advisory() {
  const { advisoryId } = useParams<{ advisoryId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload } = useData(() => getAdvisoryDetail(advisoryId!), [advisoryId]);
  const { data: rulHistory } = useData(() => getRulHistory(advisoryId!), [advisoryId]);

  const [drawer, setDrawer] = useState<"work-order" | "dismiss" | "repair" | null>(null);

  if (!advisoryId) return <EmptyState title="No advisory selected" />;
  if (loading) return <EmptyState title="Loading…" />;
  if (error || !data) return <EmptyState title="Could not load this advisory">{error}</EmptyState>;

  const { row, rul, why, costing, consequential, children, history, work_order } = data;

  return (
    <div>
      <Link to="/fm/worklist" className={styles.back}>
        ← Back to worklist
      </Link>

      <div className={styles.header}>
        <div className={styles.headline}>
          <div className={styles.badges}>
            <SeverityBadge tier={tierOfBand(row.band)} />
            <FaultClassTag value={row.fault_class} />
          </div>
          <h1 className={styles.title}>
            {row.asset_name} — {row.fault_title}
          </h1>
          <p className={styles.physics}>{row.physics_clause}</p>
        </div>
        <div className={styles.actions}>
          {row.status !== "done" && (
            <>
              <Button onClick={() => setDrawer("dismiss")}>Dismiss</Button>
              <Button onClick={() => setDrawer("repair")}>Log a repair</Button>
              <Button variant="primary" onClick={() => setDrawer("work-order")}>
                Raise work order
              </Button>
            </>
          )}
        </div>
      </div>

      {work_order && (
        <div className={styles.workOrderCard}>
          <div>
            <strong>{work_order.work_order_id}</strong> — {work_order.status}
            <div className={styles.workOrderMeta}>
              {work_order.trade} · {work_order.hours} h · {usd(work_order.cost_usd)}
              {work_order.assignee ? ` · assigned to ${work_order.assignee}` : ""}
              {work_order.scheduled_for ? ` · scheduled for ${date(work_order.scheduled_for)}` : ""}
            </div>
          </div>
        </div>
      )}

      {consequential && (
        <Panel title="This is a symptom, not the cause">
          <p>
            {consequential.mechanism} Fixing{" "}
            <Link className={styles.causeLink} to={`/fm/worklist/${consequential.cause_advisory_id}`}>
              {consequential.cause_asset_name}'s {consequential.cause_fault_title.toLowerCase()}
            </Link>{" "}
            is the recommended action — not an independent repair here.
          </p>
        </Panel>
      )}

      {children.length > 0 && (
        <Panel title="Symptoms demoted beneath this advisory" sub="Never hidden — only ranked below the cause.">
          <ul className={styles.list}>
            {children.map((c) => (
              <li key={c.advisory_id} className={styles.listItem}>
                <Link className={styles.causeLink} to={`/fm/worklist/${c.advisory_id}`}>
                  {c.asset_name}
                </Link>
                <span>— {c.fault_title}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className={styles.grid}>
        <div>
          <Panel title="Remaining life">
            {rul.published ? (
              <>
                <div className={styles.statRow}>
                  <div className={styles.stat}>
                    <span className={styles.statLabel}>Optimistic</span>
                    <span className={styles.statValue}>{dateShort(rul.p10)}</span>
                  </div>
                  <div className={styles.stat}>
                    <span className={styles.statLabel}>Likely</span>
                    <span className={styles.statValue}>{dateShort(rul.p50)}</span>
                  </div>
                  <div className={styles.stat}>
                    <span className={styles.statLabel}>Act by</span>
                    <span className={styles.statValue}>{dateShort(rul.p90)}</span>
                  </div>
                </div>
                {rulHistory && rulHistory.length > 1 && <RulFan history={rulHistory} />}
              </>
            ) : (
              <RefusalCard rul={rul} />
            )}
          </Panel>

          <Panel
            title="Why this and not the weather"
            sub={`Judged during ${why.evaluation.mode_label.toLowerCase()}, ${num(why.evaluation.hours_judged)} hours over ${why.evaluation.windows} days.`}
          >
            <div className={styles.sectionNote}>
              Already accounted for by the model: {why.evaluation.drivers.join(", ")}. Suppressed for{" "}
              {why.evaluation.hours_suppressed} h where the machine was not in a state that could be fairly judged.
            </div>

            <ul className={styles.list}>
              {why.signals.map((s) => (
                <li key={s.point_id} className={styles.listItem}>
                  <span className={styles.listItemLabel}>{s.label}</span>
                  <span>
                    {s.observed} {s.unit} observed vs {s.reference} {s.unit} expected — moved {s.moved} {s.unit} (
                    {s.sigmas.toFixed(1)}σ), instrument quality {s.quality}
                  </span>
                </li>
              ))}
            </ul>

            {why.ruled_out.length > 0 && (
              <>
                <div className={styles.statLabel} style={{ marginTop: 16, marginBottom: 8 }}>
                  Ruled out
                </div>
                <ul className={styles.list}>
                  {why.ruled_out.map((r) => (
                    <li key={r.factor} className={styles.listItem}>
                      <span className={styles.listItemLabel}>{r.factor}</span>
                      <span>{r.how}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className={styles.sectionNote} style={{ marginTop: 16 }}>
              <strong>Sensor or machine? </strong>
              {why.fault_class_reason}
              {why.bias_estimate && (
                <> Recovered bias: {why.bias_estimate.k} {why.bias_estimate.unit} on {why.bias_estimate.label}.</>
              )}
            </div>

            <p style={{ marginTop: 12, fontSize: 13, color: "var(--ink-faint)" }}>
              Compared against {why.compared_to.note} ({date(why.compared_to.from)}–{date(why.compared_to.to)}).{" "}
              {why.excluded.total > 0 &&
                `${why.excluded.total} readings excluded (${why.excluded.condemned} quality-condemned, ${why.excluded.unusable_source} from a column marked unusable at source).`}
            </p>
          </Panel>

          {history.length > 0 && (
            <Panel title="History on this machine">
              <div className={styles.timeline}>
                {history.map((h, i) => (
                  <div key={i} className={styles.timelineItem}>
                    <span className={styles.timelineDate}>{dateShort(h.t)}</span>
                    <div className={styles.timelineBody}>
                      <strong>{h.event}</strong>
                      <p>{h.note}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>

        <div>
          <Panel title="What waiting costs" sub={`Over the next ${costing.horizon_days} days`}>
            {costing.waiting.total_usd === null ? (
              <EmptyState title="Unpriced">{costing.unpriced_reason}</EmptyState>
            ) : (
              <>
                {costing.waiting.terms.map((t, i) => (
                  <div key={i} className={styles.term}>
                    <div className={styles.termLeft}>
                      <div>
                        <div className={styles.termLabel}>{t.label}</div>
                        <div className={styles.termNote}>{t.note}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <ProvenanceTag value={t.provenance} />
                      <span className={styles.termValue}>{t.value}</span>
                    </div>
                  </div>
                ))}
                <div className={styles.total}>
                  <span>Total cost of waiting</span>
                  <span>{usd(costing.waiting.total_usd)}</span>
                </div>
              </>
            )}
          </Panel>

          <Panel title="What acting costs">
            <div className={styles.term}>
              <span className={styles.termLabel}>Labour</span>
              <span className={styles.termValue}>
                {costing.acting.hours} h × ${costing.acting.labour_rate_usd}/h ({costing.acting.trade})
              </span>
            </div>
            <div className={styles.term}>
              <span className={styles.termLabel}>Parts</span>
              <span className={styles.termValue}>{usd(costing.acting.parts_usd)}</span>
            </div>
            <div className={styles.total}>
              <span>Total cost of acting</span>
              <span>{usd(costing.acting.total_usd)}</span>
            </div>
            <p className={styles.termNote} style={{ marginTop: 12 }}>
              {costing.acting.basis}
            </p>
            <ol className={styles.checklist}>
              {costing.acting.checklist.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ol>
          </Panel>

          <Panel title="Return on acting now">
            <div className={styles.statRow}>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Priority</span>
                <span className={styles.statValue}>{ratio(costing.priority)}</span>
              </div>
            </div>
            {costing.priority !== null && costing.priority < 1 && (
              <p className={styles.termNote}>
                Below 1× — the 90-day waiting cost is lower than the repair itself. Urgency here comes from occupant
                risk and severity, not from an energy return.
              </p>
            )}
          </Panel>
        </div>
      </div>

      {drawer === "work-order" && (
        <WorkOrderDrawer
          onClose={() => setDrawer(null)}
          onSubmit={async (opts) => {
            await raiseWorkOrder(advisoryId, opts);
            toast(`Work order raised for ${row.asset_name}`);
            setDrawer(null);
            reload();
          }}
        />
      )}
      {drawer === "dismiss" && (
        <DismissDrawer
          onClose={() => setDrawer(null)}
          onSubmit={async (reason, note) => {
            await dismissAdvisory(advisoryId, reason, note);
            toast(`Dismissed — ${row.asset_name}`);
            setDrawer(null);
            navigate("/fm/worklist");
          }}
        />
      )}
      {drawer === "repair" && (
        <RepairDrawer
          onClose={() => setDrawer(null)}
          onSubmit={async (note, by) => {
            await recordRepair(advisoryId, note, by);
            toast(`Repair logged for ${row.asset_name}`);
            setDrawer(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function WorkOrderDrawer({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (opts: { assignee: string; scheduledFor: string | null }) => Promise<void>;
}) {
  const [assignee, setAssignee] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <Drawer title="Raise work order" onClose={onClose}>
      <div className={styles.form}>
        <div className={styles.field}>
          <label>Assign to</label>
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Technician or crew name" />
        </div>
        <div className={styles.field}>
          <label>Schedule for (optional)</label>
          <input type="date" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
        </div>
        <Button
          variant="primary"
          className={styles.submit}
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            await onSubmit({ assignee: assignee || "Unassigned", scheduledFor: scheduledFor || null });
          }}
        >
          Raise work order
        </Button>
      </div>
    </Drawer>
  );
}

const DISMISS_REASONS: { id: DismissReason; label: string }[] = [
  { id: "already_scheduled", label: "Already scheduled elsewhere" },
  { id: "known_and_accepted", label: "Known and accepted risk" },
  { id: "false_alarm_suspected", label: "Suspected false alarm" },
  { id: "other", label: "Other" },
];

function DismissDrawer({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (reason: DismissReason, note: string) => Promise<void>;
}) {
  const [reason, setReason] = useState<DismissReason>("known_and_accepted");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <Drawer title="Dismiss advisory" onClose={onClose}>
      <div className={styles.form}>
        <div className={styles.field}>
          <label>Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value as DismissReason)}>
            {DISMISS_REASONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>Note</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this can wait" />
        </div>
        <p className={styles.termNote}>
          This leaves the worklist immediately and appears under Recently Dismissed. If it later turns out to have
          failed anyway, that will show up honestly in Track Record.
        </p>
        <Button
          variant="primary"
          className={styles.submit}
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            await onSubmit(reason, note || DISMISS_REASONS.find((r) => r.id === reason)!.label);
          }}
        >
          Dismiss
        </Button>
      </div>
    </Drawer>
  );
}

function RepairDrawer({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (note: string, by: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [by, setBy] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <Drawer title="Log a repair" onClose={onClose}>
      <div className={styles.form}>
        <div className={styles.field}>
          <label>What did the technician find and do?</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Brushed condenser tubes, moderate scale found" />
        </div>
        <div className={styles.field}>
          <label>Logged by</label>
          <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Your name" />
        </div>
        <p className={styles.termNote}>
          This closes the work order and marks the fault as done. Whether health actually recovers will show up over
          the following days in Track Record — not instantly, because that would be a claim the system cannot back
          yet.
        </p>
        <Button
          variant="primary"
          className={styles.submit}
          disabled={submitting || !note}
          onClick={async () => {
            setSubmitting(true);
            await onSubmit(note, by || "Unnamed technician");
          }}
        >
          Log repair
        </Button>
      </div>
    </Drawer>
  );
}
