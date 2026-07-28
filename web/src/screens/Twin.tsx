import { useEffect, useState } from "react";

import { api } from "../api.ts";
import { DigitalTwin } from "../components/DigitalTwin.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { ScreenHead } from "../design/ScreenHead.tsx";
import { Term } from "../design/Term.tsx";
import type { Encoding } from "../lib/twin-layout.ts";
import styles from "./Twin.module.css";
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
  // Which of the three questions the drawing is answering. Held here rather than inside
  // the drawing so it survives the clock moving and the state being refetched.
  const [encoding, setEncoding] = useState<Encoding>("condition");

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
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!topology) return <div className="muted">Loading the building…</div>;

  const node = selected
    ? (topology.nodes.find((n) => n.node_id === selected) ?? null)
    : null;

  return (
    <>
      <ScreenHead
        sub={
          <>
            Heat flows left to right: the <Term id="cooling-tower">cooling towers</Term>{" "}
            throw it away, the <Term id="chiller">chillers</Term> make cold water, the{" "}
            <Term id="air-handler">air handler</Term> blows cooled air into the rooms.
            Click any box for the instruments attached to it.
          </>
        }
        why={
          <>
            Nothing in this drawing is written into the frontend. Every box, every
            connection and every instrument comes from the building&rsquo;s semantic
            model — a machine-readable description of what is plumbed to what, in a
            standard vocabulary for building systems, see{" "}
            <Term id="brick-class">Brick class</Term>. A building with a sixth room gets
            a sixth box with no code change, and a rule written for this air handler
            applies to a machine nobody has seen yet.
          </>
        }
      >
        Where each fault sits in the plant
      </ScreenHead>

      {/* Drawing and inspector side by side rather than stacked. Clicking a node used to
          open a panel below the fold, so the picture you had just clicked scrolled out
          of view and the connection between the two was lost. */}
      <div className={node ? styles.split : styles.full}>
        <div className={styles.drawing}>
          <DigitalTwin
            topology={topology}
            state={state}
            advisories={advisories ?? []}
            selected={selected}
            onSelect={setSelected}
            encoding={encoding}
            onEncoding={setEncoding}
          />
        </div>
        {node && (
          <aside className={styles.aside}>
            <NodeInspector node={node} state={state} onClose={() => setSelected(null)} />
          </aside>
        )}
      </div>
    </>
  );
}
