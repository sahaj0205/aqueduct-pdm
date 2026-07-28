import type { FaultClass } from "../types.ts";
import styles from "./FaultClassBadge.module.css";

/**
 * What a fault is blamed on, as an outline badge.
 *
 * OUTLINE, NEVER FILLED, AND DELIBERATELY DESATURATED — DESIGN_SEMANTIC.md is explicit.
 * These classify a fault; they do not alarm about it. A filled coloured badge here would
 * compete with the severity scale beside it, and severity is the thing that is allowed to
 * shout. The distinction is carried by an icon and, for the undecided case, by a dashed
 * rule — not by hue.
 *
 * It remains the field an operator reads before almost anything else, because it decides
 * which van goes out: SENSOR sends somebody with a reference probe, EQUIPMENT sends
 * somebody to open the machine, and on the same reported symptom those two differ by more
 * than three times in cost.
 *
 * AMBIGUOUS IS DASHED, not dressed as an alarm. It is a real and honest outcome — the
 * instrumentation cannot decide this case — and making it look urgent would push an
 * operator to treat it as though it had been decided.
 */

const HINT: Record<FaultClass, string> = {
  sensor:
    "The measurement is wrong and the machine is not: a bias on one reading reconciles " +
    "every relation it appears in.",
  equipment: "The measurements agree with each other and the machine is what changed.",
  control:
    "An actuator is not following its command, which invalidates the other two tests.",
  ambiguous:
    "The instrumentation cannot decide this case. Adding one relation covering the " +
    "suspect point would make it decidable.",
};

/** One glyph per class, drawn on a 12-unit grid. Square ends, to match the geometry. */
function Icon({ value }: { value: FaultClass }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.25,
  } as const;
  return (
    <svg viewBox="0 0 12 12" width={11} height={11} aria-hidden="true">
      {value === "sensor" && (
        // a waveform: what an instrument produces
        <path d="M0.5 6 H2 L3.25 2.5 L4.75 9.5 L6.25 3.5 L7.5 6 H11.5" {...common} />
      )}
      {value === "equipment" && (
        // a gear: the machine itself
        <>
          <circle cx="6" cy="6" r="2.2" {...common} />
          <path d="M6 0.75V2.2M6 9.8v1.45M0.75 6H2.2M9.8 6h1.45" {...common} />
          <path d="M2.3 2.3 3.3 3.3M8.7 8.7l1 1M9.7 2.3 8.7 3.3M3.3 8.7l-1 1" {...common} />
        </>
      )}
      {value === "control" && (
        // sliders: the logic driving them
        <>
          <path d="M1 3.5H11M1 8.5H11" {...common} />
          <path d="M4 1.9v3.2M8 6.9v3.2" {...common} />
        </>
      )}
      {value === "ambiguous" && (
        // a question: nothing has been decided
        <>
          <path d="M4.2 4.3a1.85 1.85 0 1 1 1.85 2v1.1" {...common} />
          <path d="M6.05 9.4v.9" {...common} />
        </>
      )}
    </svg>
  );
}

export function FaultClassBadge({ value }: { value: FaultClass }) {
  return (
    <span className={`${styles.badge} ${styles[value]}`} title={HINT[value]}>
      <Icon value={value} />
      {value}
    </span>
  );
}
