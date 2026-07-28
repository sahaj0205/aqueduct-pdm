import { useEffect, useMemo, useState } from "react";

import { api, reveal } from "../api.ts";
import { PredictedVsActual } from "../components/PredictedVsActual.tsx";
import { RulExplainer } from "../components/RulExplainer.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import { Term } from "../design/Term.tsx";
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

      <div style={{ display: "flex", gap: 8, margin: "0 0 14px", flexWrap: "wrap" }}>
        {["ahu-1", "chiller-1", "chiller-2"].map((id) => (
          <button
            key={id}
            onClick={() => setAssetId(id)}
            style={{
              fontSize: 12,
              padding: "5px 11px",
              borderRadius: 3,
              cursor: "pointer",
              border: "1px solid var(--line)",
              background: id === assetId ? "var(--accent)" : "var(--panel-2)",
              color: id === assetId ? "#ffffff" : "var(--muted)",
            }}
          >
            {id}
          </button>
        ))}
        {modes.length > 0 && (
          <select
            value={modeId}
            onChange={(e) => setModeId(e.target.value)}
            style={{
              fontSize: 12,
              padding: "5px 8px",
              borderRadius: 3,
              background: "var(--panel-2)",
              color: "var(--text)",
              border: "1px solid var(--line)",
            }}
          >
            {modes.map((m) => (
              <option key={m} value={m}>
                {m} ({history?.modes[m]?.length ?? 0} estimates)
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <div className="notice">
          <strong>No remaining-life history for {assetId}.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
        </div>
      )}

      {!error && history && points.length > 0 && (
        <>
          <section
            style={{
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: "12px 15px 13px",
            }}
          >
            <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>
              What the model does well: the interval closes
            </h3>
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap", fontSize: 12 }}>
              <span>
                <strong style={{ fontFamily: "var(--mono)", fontSize: 17 }}>
                  {close.percentClosed === null
                    ? "—"
                    : `${close.percentClosed.toFixed(0)}%`}
                </strong>
                <span className="muted"> closed over the run</span>
              </span>
              <span className="muted">
                {close.bounded} bounded estimate{close.bounded === 1 ? "" : "s"},{" "}
                {close.unbounded} where an end was left unbounded
              </span>
              <span className="muted">
                {close.monotone
                  ? "narrowed at every step"
                  : "widened locally on the way — each estimate is refitted from that day's evidence, and a run of flatter days genuinely is weaker evidence about a rate"}
              </span>
            </div>
          </section>
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
