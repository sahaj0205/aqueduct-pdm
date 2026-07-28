import { useEffect, useState } from "react";

import { reveal } from "../api.ts";
import { CascadeList } from "../components/CascadeList.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import styles from "./Reveal.module.css";
import type { AtMoment, Cascade, InjectedFault } from "../types.ts";

/**
 * The answer key: what was actually wrong with this building at the clock's moment.
 *
 * GATED BEHIND A CLICK, and that is the whole design of this screen. It is the
 * demonstration's reveal, and a screen that has already told you the answer before you
 * asked has spent the moment it exists for. The tab is visible; the content is one
 * action away.
 *
 * Served by a SEPARATE PROCESS on a SEPARATE CREDENTIAL. The API every other screen
 * reads connects as a role with no grant of any kind on the schema this data lives in —
 * an endpoint there that asked for a label fails with permission denied. That is what
 * makes every accuracy figure in this project mean something, and it is why this screen
 * is the only one that stops working when one particular process is not running.
 */

interface Props {
  at: string | null;
}

function FaultRow({ fault, tone }: { fault: InjectedFault; tone: string }) {
  return (
    <div className={styles.fault}>
      <span className={`${styles.mode} ${styles[tone]}`}>
        {fault.fault_mode.replace(/_/g, " ")}
      </span>
      <span className={styles.when}>
        {fault.asset_id} · injected {fault.t_onset.slice(0, 10)}
        {fault.t_failure && ` · failed ${fault.t_failure.slice(0, 10)}`} ·{" "}
        {fault.profile}
      </span>
      <span className={styles.ladder}>
        {fault.ladder.length} rung{fault.ladder.length === 1 ? "" : "s"} →{" "}
        {fault.terminal_severity}
      </span>
    </div>
  );
}

export function Reveal({ at }: Props) {
  const [shown, setShown] = useState(false);
  const [moment, setMoment] = useState<AtMoment | null>(null);
  const [missing, setMissing] = useState(false);
  const [cascades, setCascades] = useState<Record<string, Cascade | null>>({});
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    if (!shown || !at) return;
    let cancelled = false;
    void (async () => {
      const next = await reveal.at(at);
      if (cancelled) return;
      setMoment(next);
      setMissing(next === null);
    })();
    return () => {
      cancelled = true;
    };
  }, [shown, at]);

  async function loadCascade(scenarioId: string) {
    setLoading(scenarioId);
    const found = await reveal.cascade(scenarioId);
    setCascades((current) => ({ ...current, [scenarioId]: found }));
    setLoading(null);
  }

  if (!shown) {
    return (
      <section>
        <ScreenHead sub="Every other screen shows what the system worked out from sensor readings. This one shows what was actually true.">
          What was actually broken
        </ScreenHead>
        <div className={`notice ${styles.gate}`}>
          <strong>Worth forming a view on the other screens first.</strong>
          <div className={styles.gateBody}>
            The faults in these recordings were introduced deliberately, so we know
            exactly which machine broke, on what day, and how bad it got. This page is
            that record.
            <br />
            <br />
            The half of the system that does the detecting has never seen it. It signs in
            to the database as a user with <strong>no permission to read these
            records at all</strong> — an attempt from that side comes back{" "}
            <code>permission denied</code>. That is why, when the system gets something
            right, it cannot have been reading the answers.
          </div>
          <button className={styles.show} onClick={() => setShown(true)}>
            Show me what was injected
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <ScreenHead
        sub={
          at
            ? `The ground truth as the clock stands at ${at.slice(0, 10)}.`
            : "The clock has no position yet."
        }
        why={
          <>
            Served by a separate process on the admin credential — the only credential in
            this system permitted to read the ground truth. Every other screen connects as
            a role that has no grant of any kind on this data, which is why this is the
            one page that stops working when one particular process is not running, and
            why the accuracy numbers elsewhere are not marking their own homework.
          </>
        }
      >
        What was actually broken
      </ScreenHead>

      {missing && (
        <div className="notice">
          <strong>The reveal service is not running.</strong>
          <p className="muted">
            It is a separate process on the admin credential — start it with{" "}
            <code>make reveal</code>. Every other screen works without it, which is the
            point.
          </p>
        </div>
      )}

      {moment && (
        <>
          {(
            [
              ["active", "running right now", "running"],
              ["already_failed", "already past failure", "failed"],
              ["not_yet_injected", "not injected yet", "pending"],
            ] as const
          ).map(([field, label, tone]) => {
            const faults = moment[field];
            return (
              <div key={field} className={styles.group}>
                <h3 className={`${styles.groupHead} ${styles[tone]}`}>
                  {label} <span className={styles.count}>{faults.length}</span>
                </h3>
                {faults.length === 0 ? (
                  <div className={styles.empty}>none</div>
                ) : (
                  faults.map((fault) => (
                    <div key={fault.scenario_id}>
                      <FaultRow fault={fault} tone={tone} />
                      {field === "active" && (
                        <div className={styles.cascade}>
                          {cascades[fault.scenario_id] === undefined ? (
                            <button
                              onClick={() => void loadCascade(fault.scenario_id)}
                              disabled={loading === fault.scenario_id}
                              className={styles.ask}
                            >
                              {loading === fault.scenario_id
                                ? "measuring…"
                                : "which instrument moved first?"}
                            </button>
                          ) : cascades[fault.scenario_id] ? (
                            <CascadeList cascade={cascades[fault.scenario_id]!} />
                          ) : (
                            <span className={styles.none}>
                              no cascade could be computed for this run
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            );
          })}

          {moment.clean_runs_covering.length > 0 && (
            <p className={styles.cleanRuns}>
              <strong>{moment.clean_runs_covering.length} fault-free run
              {moment.clean_runs_covering.length === 1 ? "" : "s"}</strong> also cover
              {moment.clean_runs_covering.length === 1 ? "s" : ""} this moment:{" "}
              {moment.clean_runs_covering.map((r) => r.scenario_id).join(", ")}. Any
              finding raised against those is wrong by definition, which is what makes
              the false-alarm rate measurable at all.
            </p>
          )}
        </>
      )}
    </section>
  );
}
