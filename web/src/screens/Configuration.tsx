import { useEffect, useState } from "react";

import { api } from "../api.ts";
import { Picker } from "../design/Picker.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import { Term } from "../design/Term.tsx";
import type { InterventionConfig, ModeConfig, RuleConfig } from "../types.ts";
import styles from "../components/ConfigTable.module.css";

/**
 * Everything this system was configured with, and the reason for every number in it.
 *
 * The point of the screen is the last column of every table. Each failure mode's
 * threshold has a written physical justification beside it; each intervention has a
 * basis for its cost; each rule declares which operating modes it may run in and how
 * long a firing must hold. None of that is documentation kept alongside the system — the
 * rationale column is NOT NULL with a length check, so a threshold cannot enter this
 * database without a reason attached, and the shortest one here is over five hundred
 * characters.
 *
 * One failure mode here has no indicator expression at all: a loaded filter is measured
 * by the pressure drop across it and neither source dataset publishes one. Its threshold
 * is recorded anyway, because 250 Pa is the real change-out criterion, and its rationale
 * opens by saying it is not computable in this building. Showing it rather than hiding
 * it is the point — the alternative is a configuration screen that implies full
 * coverage.
 *
 * The three tables are configured in two different places and the difference is honest.
 * Failure modes and interventions are rows, so adding either is data. Rules are Python,
 * because a rule is an expression over readings and making it a row would mean inventing
 * a small language to put in the row. What IS data about a rule is the Brick class it
 * applies to, which is what lets a fourth kind of machine inherit the existing rules
 * without a code change.
 */

type Tab = "rules" | "modes" | "interventions";

export function Configuration() {
  const [tab, setTab] = useState<Tab>("modes");
  const [rules, setRules] = useState<RuleConfig[] | null>(null);
  const [modes, setModes] = useState<ModeConfig[] | null>(null);
  const [interventions, setInterventions] = useState<InterventionConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [r, m, i] = await Promise.all([
          api.configRules(),
          api.configModes(),
          api.configInterventions(),
        ]);
        if (cancelled) return;
        setRules(r);
        setModes(m);
        setInterventions(i);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="notice">
        <strong>The configuration could not be read.</strong>
        <p className="muted">{error}</p>
      </div>
    );
  }

  const counts: Record<Tab, number> = {
    rules: rules?.length ?? 0,
    modes: modes?.length ?? 0,
    interventions: interventions?.length ?? 0,
  };
  const labels: Record<Tab, string> = {
    rules: "rules",
    modes: "failure modes",
    interventions: "interventions",
  };

  return (
    <section>
      <ScreenHead
        sub={
          <>
            Click any row for the written physical justification stored beside it. The
            shortest one here runs to over five hundred characters.
          </>
        }
        why={
          <>
            The rationale is not documentation kept alongside the system. It is a{" "}
            <code>NOT NULL</code> column with a minimum length check, so a threshold
            physically cannot enter this database without a reason attached to it.
            <br />
            <br />
            <Term id="failure-mode">Failure modes</Term> and interventions are rows, so
            adding either is data rather than code. Rules are Python, because a rule is an
            expression over readings and making it a row would mean inventing a small
            language to put in the row. What <em>is</em> data about a rule is the{" "}
            <Term id="brick-class">Brick class</Term> it applies to, which is what lets a
            fourth kind of machine inherit every existing rule with no code change at all.
            <br />
            <br />
            One failure mode here has no indicator expression: a loaded filter is measured
            by the pressure drop across it and neither source dataset publishes one. Its
            threshold is recorded anyway, because 250 Pa is the real change-out criterion,
            and its rationale opens by saying it is not computable in this building.
            Showing it rather than hiding it is the point — the alternative is a screen
            that implies full coverage.
          </>
        }
      >
        Every number in this system, and why it is that number
      </ScreenHead>

      <Picker
        label="showing"
        value={tab}
        onChange={(next) => {
          setTab(next);
          setOpen(null);
        }}
        options={(["modes", "rules", "interventions"] as Tab[]).map((t) => ({
          id: t,
          label: labels[t],
          sub: `${counts[t]}`,
        }))}
      />

      {tab === "modes" && modes && (
        <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>failure mode</th>
              <th>applies to</th>
              <th className={styles.r}>fails at</th>
              <th>process</th>
              <th>indicator</th>
            </tr>
          </thead>
          <tbody>
            {modes.map((m) => (
              <>
                <tr
                  key={m.mode_id}
                  className={styles.row}
                  onClick={() => setOpen(open === m.mode_id ? null : m.mode_id)}
                >
                  <td>
                    <div className={styles.id}>{m.mode_name}</div>
                    <div className={styles.code}>{m.mode_id}</div>
                  </td>
                  <td className={styles.sub}>{m.brick_class}</td>
                  <td className={styles.r}>
                    <strong>
                      {m.failure_threshold} {m.indicator_unit}
                    </strong>
                  </td>
                  <td className={styles.sub}>{m.degradation_process}</td>
                  <td className={styles.mono}>
                    {m.indicator_expression ?? (
                      <span className={styles.notMeasured}>
                        not computable in this building
                      </span>
                    )}
                  </td>
                </tr>
                {open === m.mode_id && (
                  <tr key={`${m.mode_id}-why`}>
                    <td colSpan={5} className={styles.why}>
                      <strong>Why {m.failure_threshold} {m.indicator_unit} and not
                      another number.</strong>{" "}
                      {m.threshold_rationale}
                      {m.applies_when && (
                        <div className={styles.applies}>
                          only evaluated when: <code>{m.applies_when}</code>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {tab === "rules" && rules && (
        <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>rule</th>
              <th>applies to</th>
              <th>runs in</th>
              <th className={styles.r}>quality bar</th>
              <th className={styles.r}>must hold</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.rule_id}>
                <td>
                  <div className={styles.id}>{r.rule_id}</div>
                  <div className={styles.sub}>{r.description}</div>
                </td>
                <td className={styles.sub}>{r.applies_to}</td>
                <td className={styles.sub}>
                  {r.modes.length === 0
                    ? "any mode"
                    : r.modes.map((m) => m.replace(/_/g, " ")).join(", ")}
                </td>
                <td className={styles.r}>{r.min_input_quality}</td>
                <td className={styles.r}>{r.persistence_minutes} min</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {tab === "interventions" && interventions && (
        <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>intervention</th>
              <th>answers</th>
              <th>when classed</th>
              <th className={styles.r}>hours</th>
              <th className={styles.r}>parts</th>
            </tr>
          </thead>
          <tbody>
            {interventions.map((i) => (
              <>
                <tr
                  key={i.intervention_id}
                  className={styles.row}
                  onClick={() =>
                    setOpen(open === i.intervention_id ? null : i.intervention_id)
                  }
                >
                  <td>
                    <div className={styles.id}>{i.description}</div>
                    <div className={styles.code}>{i.intervention_id}</div>
                  </td>
                  <td className={styles.sub}>{i.applies_to_fault}</td>
                  <td className={styles.sub}>{i.applies_to_class ?? "any"}</td>
                  <td className={styles.r}>{i.duration_hours}</td>
                  <td className={styles.r}>${i.parts_cost_usd.toFixed(2)}</td>
                </tr>
                {open === i.intervention_id && (
                  <tr key={`${i.intervention_id}-why`}>
                    <td colSpan={5} className={styles.why}>
                      <strong>Basis.</strong> {i.basis}
                      <div className={styles.applies}>
                        skills: {i.skills.join(", ")}
                        {i.parts.length > 0 && ` · parts: ${i.parts.join(", ")}`}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {!rules && <div className="muted">Loading the configuration…</div>}
    </section>
  );
}
