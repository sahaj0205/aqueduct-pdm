import { useEffect, useState } from "react";

import { api } from "../api.ts";
import { Funnel } from "../components/Funnel.tsx";
import { StageDetail } from "../components/StageDetail.tsx";
import { Picker } from "../design/Picker.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import { Term } from "../design/Term.tsx";
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
  // Identifier to human name, fetched once. The picker used to be labelled with raw
  // identifiers, which is the thing R4 stopped doing everywhere else.
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const assets = await api.assets();
        if (cancelled) return;
        setNames(Object.fromEntries(assets.map((a) => [a.asset_id, a.name])));
      } catch {
        // A missing name list is not an error worth showing: the picker falls back to
        // identifiers, which is exactly what it displayed before this existed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      <ScreenHead
        sub={
          <>
            Read downwards. Each row is a stage that could have raised an alarm and
            mostly did not, with the reason in the engine&rsquo;s own words.
          </>
        }
        why={
          <>
            The point of this screen is that the low{" "}
            <Term id="false-alarm-rate">false alarm rate</Term> is not the product of a
            cleverer detector. It is the product of ten successive refusals to judge,
            none of which were visible anywhere before this table existed.
            <br />
            <br />
            The right-hand column is the same machine on the same day of the year with
            nothing wrong with it — same weather, same occupancy, because every{" "}
            <Term id="era">run</Term> in this database reads the same source year shifted
            by whole years. Where that column reads zero and this one does not, the
            difference is the fault and nothing else. Rules still fire on healthy
            equipment; every one of those firings dies at the{" "}
            <Term id="persistence">persistence</Term> requirement.
          </>
        }
      >
        Everything the system threw away, and why
      </ScreenHead>

      <Picker
        label="machine"
        value={assetId}
        onChange={(id) => {
          setAssetId(id);
          setSelected(null);
        }}
        options={MACHINES.map((id) => ({
          id,
          // The human name where the asset list has one, falling back to the identifier
          // rather than to a blank while that list is still loading.
          label: names[id] ?? id,
          sub: id,
        }))}
      />

      {error && (
        <div className="notice">
          <strong>No trace for {names[assetId] ?? assetId} on this day.</strong>
          <p className="muted">{error}</p>
          <p className="muted">
            A machine with no readings that day has no row, which is a fact about the run
            rather than a gap. Move the clock into a run this machine is part of, or
            populate the table with <code>make engine-trace</code>.
          </p>
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
