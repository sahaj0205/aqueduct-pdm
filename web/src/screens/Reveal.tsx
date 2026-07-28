import { useEffect, useState } from "react";

import { reveal } from "../api.ts";
import { CascadeList } from "../components/CascadeList.tsx";
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
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "baseline",
        flexWrap: "wrap",
        padding: "7px 0",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: tone, minWidth: 200 }}>
        {fault.fault_mode.replace(/_/g, " ")}
      </span>
      <span className="muted" style={{ fontSize: 11.5 }}>
        {fault.asset_id} · injected {fault.t_onset.slice(0, 10)}
        {fault.t_failure && ` · failed ${fault.t_failure.slice(0, 10)}`} ·{" "}
        {fault.profile}
      </span>
      <span className="muted" style={{ fontSize: 11 }}>
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
        <div className="masthead" style={{ marginBottom: 10 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>The answer key</h2>
          <span className="sub">what was actually wrong, as opposed to what was found</span>
        </div>
        <div className="notice">
          <strong>This is the answer.</strong>
          <div className="muted" style={{ marginTop: 7, lineHeight: 1.6, maxWidth: "78ch" }}>
            Everything on every other screen was worked out from readings alone. This one
            says what was really injected, when, and how bad it got — and it is served by
            a different process on a different credential, because the detection path
            connects as a role that has no access to this data at all. An endpoint over
            there that asked for a label fails with <code>permission denied</code>.
            <br />
            <br />
            Worth looking at the other screens first and forming a view. Then check it.
          </div>
          <button
            onClick={() => setShown(true)}
            style={{
              marginTop: 12,
              fontSize: 12.5,
              padding: "7px 14px",
              borderRadius: 3,
              cursor: "pointer",
              border: "none",
              background: "var(--warn)",
              color: "#ffffff",
              fontWeight: 600,
            }}
          >
            Show me what was injected
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="masthead" style={{ marginBottom: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>The answer key</h2>
        <span className="sub">
          {at ? `as the clock stands at ${at.slice(0, 10)}` : "no clock position"}
        </span>
      </div>

      {missing && (
        <div className="notice">
          <strong>The reveal service is not running.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            It is a separate process on the admin credential — start it with{" "}
            <code>make reveal</code>. Every other screen works without it, which is the
            point.
          </div>
        </div>
      )}

      {moment && (
        <>
          {(
            [
              ["active", "running right now", "var(--bad)"],
              ["already_failed", "already past failure", "var(--warn)"],
              ["not_yet_injected", "not injected yet", "var(--faint)"],
            ] as const
          ).map(([field, label, tone]) => {
            const faults = moment[field];
            return (
              <div key={field} style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: 12, margin: "0 0 4px", color: tone }}>
                  {label} — {faults.length}
                </h3>
                {faults.length === 0 ? (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    none
                  </div>
                ) : (
                  faults.map((fault) => (
                    <div key={fault.scenario_id}>
                      <FaultRow fault={fault} tone={tone} />
                      {field === "active" && (
                        <div style={{ padding: "6px 0 2px" }}>
                          {cascades[fault.scenario_id] === undefined ? (
                            <button
                              onClick={() => void loadCascade(fault.scenario_id)}
                              disabled={loading === fault.scenario_id}
                              style={{
                                fontSize: 11.5,
                                padding: "4px 10px",
                                borderRadius: 3,
                                cursor: "pointer",
                                background: "var(--panel-2)",
                                color: "var(--muted)",
                                border: "1px solid var(--line)",
                              }}
                            >
                              {loading === fault.scenario_id
                                ? "measuring…"
                                : "which instrument moved first?"}
                            </button>
                          ) : cascades[fault.scenario_id] ? (
                            <CascadeList cascade={cascades[fault.scenario_id]!} />
                          ) : (
                            <span className="muted" style={{ fontSize: 11 }}>
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
            <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
              {moment.clean_runs_covering.length} fault-free run
              {moment.clean_runs_covering.length === 1 ? "" : "s"} also cover
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
