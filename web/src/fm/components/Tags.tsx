import { FAULT_CLASS_LABEL } from "../lib/format.ts";
import type { CostTerm, FaultClass } from "../types.ts";
import styles from "./Tags.module.css";

/** Stage-10's verdict, shown as a classification rather than an alarm. `ambiguous` is
 *  drawn distinctly — dashed, desaturated — because it is a real, unresolved answer, not
 *  a missing one. */
export function FaultClassTag({ value }: { value: FaultClass }) {
  return (
    <span className={`${styles.faultTag} ${value === "ambiguous" ? styles.ambiguous : ""}`}>
      {FAULT_CLASS_LABEL[value]}
    </span>
  );
}

/** Where a cost figure came from. The difference between "measured on this machine"
 *  and "a handbook rule of thumb" is what decides whether a number survives being
 *  forwarded to finance. */
export function ProvenanceTag({ value }: { value: CostTerm["provenance"] }) {
  return <span className={`${styles.provenance} ${value === "measured" ? styles.measured : ""}`}>{value}</span>;
}
