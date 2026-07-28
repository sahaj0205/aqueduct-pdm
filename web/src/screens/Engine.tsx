import { useEffect, useState } from "react";

import { api } from "../api.ts";
import { Funnel } from "../components/Funnel.tsx";
import { StageDetail } from "../components/StageDetail.tsx";
import type { MachineTrace, TwinState } from "../types.ts";

/**
 * The engine screen: what the detection pipeline did, and everything it declined to do.
 *
 * Every other screen shows what the system concluded. This one shows how it got there.
 * The argument it exists to make is that the false-alarm rate — one finding per 604
 * healthy machine-days — is not the product of a cleverer detector. It is the product
 * of ten successive refusals to judge, none of which were visible anywhere before this
 * table existed.
 */

const MACHINES = ["ahu-1", "chiller-1", "chiller-2", "chiller-3"];

interface Props {
  at: string | null;
  twinState: TwinState | null;
}

export function Engine({ at }: Props) {
  const [assetId, setAssetId] = useState("chiller-1");
  const [trace, setTrace] = useState<MachineTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (!at) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const next = await api.engineTrace(assetId, at);
        if (!cancelled) setTrace(next);
      } catch (cause) {
        if (!cancelled) {
          setTrace(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, at]);

  const openStage = trace && selected !== null
    ? (trace.stages.find((s) => s.ordinal === selected) ?? null)
    : null;
  const openClean = openStage && trace?.clean
    ? (trace.clean.find((s) => s.ordinal === openStage.ordinal) ?? null)
    : null;

  return (
    <section>
      <div className={"masthead"} style={{ marginBottom: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>The engine</h2>
        <span className="sub">
          what the pipeline did on one machine on one day, stage by stage
        </span>
      </div>

      <p className="muted" style={{ maxWidth: "80ch", lineHeight: 1.55, marginTop: 0 }}>
        Read this downwards. Each row is a stage that could have raised something and
        mostly did not, with the reason underneath in the engine&rsquo;s own words. The
        right-hand column is the same machine on the same day of the year with nothing
        wrong — same weather, same occupancy, because every run in this database reads
        the same source year shifted by whole years. Where that column reads zero and
        this one does not, the difference is the fault.
      </p>

      <div style={{ display: "flex", gap: 8, margin: "12px 0 14px", flexWrap: "wrap" }}>
        {MACHINES.map((id) => (
          <button
            key={id}
            onClick={() => {
              setAssetId(id);
              setSelected(null);
            }}
            style={{
              fontSize: 12,
              padding: "5px 11px",
              borderRadius: 3,
              cursor: "pointer",
              border: "1px solid var(--line)",
              background: id === assetId ? "var(--accent)" : "var(--panel-2)",
              color: id === assetId ? "#0d141c" : "var(--muted)",
            }}
          >
            {id}
          </button>
        ))}
      </div>

      {error && (
        <div className="notice">
          <strong>No trace for {assetId} on this day.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            A machine with no readings that day has no row, which is a fact about the
            run rather than a gap. Move the clock into a run this machine is part of, or
            populate the table with <code>make engine-trace</code>.
          </div>
        </div>
      )}

      {!error && !trace && <div className="muted">Loading the trace…</div>}

      {!error && trace && (
        <>
          <Funnel
            stages={trace.stages}
            clean={trace.clean}
            cleanAsOf={trace.clean_as_of}
            selected={selected}
            onSelect={setSelected}
          />
          {openStage ? (
            <StageDetail stage={openStage} clean={openClean} />
          ) : (
            <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
              Click any stage for what it was given, what it threw away, and what it
              recorded while running.
            </p>
          )}
        </>
      )}
    </section>
  );
}
