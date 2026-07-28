import { useEffect, useMemo, useState } from "react";

import { api, reveal } from "../api.ts";
import { PredictedVsActual } from "../components/PredictedVsActual.tsx";
import { RulExplainer } from "../components/RulExplainer.tsx";
import { Picker } from "../design/Picker.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import { Stat, StatRow, Unit } from "../design/Stat.tsx";
import { Term } from "../design/Term.tsx";
import styles from "./Prediction.module.css";
import { narrowing, toEpoch } from "../lib/chart.ts";
import type { AnswerKey, RulExplanation, RulHistory } from "../types.ts";

/**
 * Prediction: how a remaining life is arrived at, and how far off it was.
 *
 * Three things in order, and the order is the argument. The narrowing summary shows the
 * interval closing as evidence accumulates, which is what the model does well. Then
 * predicted-against-actual shows the model missing, consistently and in the dangerous
 * direction. The explainer last, so a reader who wants to check either claim can follow
 * every step from a raw instrument reading to the interval.
 *
 * A screen that stopped after the first would be a sales pitch.
 *
 * The fan chart on the advisory detail is NOT reused here: it takes an advisory payload
 * and is built around one open advisory, and fabricating a payload to borrow it would
 * couple this screen to a shape it does not have. `narrowing()` from lib/chart.ts is
 * pure and is reused directly, so the close percentage quoted here and the one on the
 * advisory cannot disagree.
 */

// The series the whole demonstration points at: eighty-four estimates whose interval
// closes from 2,259 days to 59 as the evidence goes from 14 samples to 53, on a machine
// whose true failure the model never actually reaches. Both stories in one series.
const DEFAULT = { assetId: "ahu-1", modeId: "coil-valve-leak-by" };

interface Props {
  at: string | null;
}

export function Prediction({ at }: Props) {
  const [assetId, setAssetId] = useState(DEFAULT.assetId);
  const [modeId, setModeId] = useState(DEFAULT.modeId);
  const [history, setHistory] = useState<RulHistory | null>(null);
  const [explanation, setExplanation] = useState<RulExplanation | null>(null);
  const [key, setKey] = useState<AnswerKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Identifier to human name for the picker, same as the engine screen. A missing list
  // is not an error: the picker falls back to identifiers, which is what it used to show.
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const assets = await api.assets();
        if (!cancelled) {
          setNames(Object.fromEntries(assets.map((a) => [a.asset_id, a.name])));
        }
      } catch {
        /* identifiers only, which is what this showed before the names existed */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const answer = await reveal.scenarios();
      if (!cancelled) setKey(answer);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        // No as_of on the history: this screen is about the whole arc of a prediction,
        // and truncating it at the clock would hide the thing it exists to show.
        const next = await api.rulHistory(assetId);
        if (!cancelled) setHistory(next);
      } catch (cause) {
        if (!cancelled) {
          setHistory(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const points = history?.modes[modeId] ?? [];

  useEffect(() => {
    const last = points[points.length - 1];
    if (!last) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.explainRul(assetId, modeId, at ?? last.as_of);
        if (!cancelled) setExplanation(next);
      } catch {
        if (!cancelled) setExplanation(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, modeId, at, points.length]);

  // The answer key's failure date for whichever fault was injected into this machine,
  // matched by era so a machine appearing in several runs takes the right one.
  const actualFailure = useMemo(() => {
    if (!key || points.length === 0) return null;
    const era = points[0]!.as_of.slice(0, 4);
    const fault = key.faults.find(
      (f) => f.asset_id === assetId && f.t_onset.slice(0, 4) === era,
    );
    return fault?.t_failure ?? null;
  }, [key, points, assetId]);

  const modes = history ? Object.keys(history.modes).sort() : [];

  const close = useMemo(
    () =>
      narrowing(
        points.map((p) => ({
          t: toEpoch(p.as_of),
          p10: p.p10,
          p50: p.p50,
          p90: p.p90,
          width: p.width,
          n: p.n_samples,
        })),
      ),
    [points],
  );

  return (
    <section>
      <ScreenHead
        sub={
          <>
            Never a single date — always a range, and the range narrows as evidence
            arrives. Below it, the same model measured against what actually happened.
          </>
        }
        why={
          <>
            Three things in order, and the order is the argument. First the range closing
            as evidence accumulates, which is what the model does well. Then the same
            prediction set against the real failure date, where it misses consistently
            and in the dangerous direction — late. The step-by-step derivation last, so
            anyone wanting to check either claim can follow it from a raw instrument
            reading to the interval.
            <br />
            <br />A screen that stopped after the first of those would be a sales pitch.
            See <Term id="rul">remaining useful life</Term> and{" "}
            <Term id="percentile-band">p10 / p50 / p90</Term>.
          </>
        }
      >
        How long it has left, and how sure we are
      </ScreenHead>

      <div className={styles.controls}>
        <Picker
          label="machine"
          value={assetId}
          onChange={setAssetId}
          options={["ahu-1", "chiller-1", "chiller-2"].map((id) => ({
            id,
            label: names[id] ?? id,
            sub: id,
          }))}
        />
        {modes.length > 1 && (
          <Picker
            label="failure mode"
            value={modeId}
            onChange={setModeId}
            options={modes.map((m) => ({
              id: m,
              label: m.replace(/-/g, " "),
              sub: `${history?.modes[m]?.length ?? 0} estimates`,
            }))}
          />
        )}
      </div>

      {error && (
        <div className="notice">
          <strong>No remaining-life history for {names[assetId] ?? assetId}.</strong>
          <p className="muted">{error}</p>
        </div>
      )}

      {!error && history && points.length > 0 && (
        <>
          {/* What the model does WELL, stated first and given the size of a finding.
              The chart below it is the unflattering half, and a screen that led with
              the unflattering half would be as one-sided as one that omitted it. */}
          <div className={styles.hero}>
            <StatRow>
              <Stat
                size="hero"
                tone="good"
                label="The range closes"
                value={
                  close.percentClosed === null ? (
                    "—"
                  ) : (
                    <>
                      {close.percentClosed.toFixed(0)}
                      <Unit>%</Unit>
                    </>
                  )
                }
                caption="narrower at the end of the run than at the start, as evidence accumulates"
              />
              <Stat
                label="Estimates with both ends"
                value={close.bounded}
                caption={
                  close.unbounded === 0
                    ? "every estimate on this series was bounded at both ends"
                    : `${close.unbounded} more left one end open — the model refusing to bound a crossing is an answer, not a gap`
                }
              />
              <Stat
                label="Shape of the closing"
                value={close.monotone ? "steady" : "uneven"}
                caption={
                  close.monotone
                    ? "narrowed at every single step"
                    : "widened locally on the way. Each estimate is refitted from that day's evidence, and a run of flatter days genuinely is weaker evidence about a rate"
                }
              />
            </StatRow>
          </div>
          <PredictedVsActual
            points={points}
            actualFailure={actualFailure}
            modeId={modeId}
          />
          {explanation && <RulExplainer explanation={explanation} />}
        </>
      )}

      {!error && history && points.length === 0 && (
        <div className="muted">
          Nothing published for {modeId} on {assetId}.
        </div>
      )}
      {!error && !history && <div className="muted">Loading the history…</div>}
    </section>
  );
}
