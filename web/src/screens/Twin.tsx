import { useEffect, useState } from "react";

import { api } from "../api.ts";
import { DigitalTwin } from "../components/DigitalTwin.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import type { AdvisorySummary, TwinState, TwinTopology } from "../types.ts";

/**
 * The twin screen: the building, and whatever node is open.
 *
 * Two fetches with very different lifetimes, which is the whole reason this screen has
 * its own state rather than taking everything from the shell. The topology is the shape
 * of the building and cannot change while the API runs, so it is fetched once. The state
 * is every live number for one moment and is refetched whenever the clock moves.
 * Binding them together would mean refetching thirty-one nodes' worth of structure on
 * every tick of a running clock.
 */

interface Props {
  /** ISO moment from the shared clock, or null before the clock has a position. */
  at: string | null;
  advisories: AdvisorySummary[] | null;
}

export function Twin({ at, advisories }: Props) {
  const [topology, setTopology] = useState<TwinTopology | null>(null);
  const [state, setState] = useState<TwinState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.twinTopology();
        if (!cancelled) setTopology(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!at) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.twinState(at);
        if (!cancelled) setState(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [at]);

  if (error) {
    return (
      <div className="notice">
        <strong>The twin could not be drawn.</strong>
        <div className="muted" style={{ marginTop: 6 }}>
          {error}
        </div>
      </div>
    );
  }
  if (!topology) return <div className="muted">Loading the building…</div>;

  const node = selected
    ? (topology.nodes.find((n) => n.node_id === selected) ?? null)
    : null;

  return (
    <>
      <DigitalTwin
        topology={topology}
        state={state}
        advisories={advisories ?? []}
        selected={selected}
        onSelect={setSelected}
      />
      {node && (
        <NodeInspector node={node} state={state} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
