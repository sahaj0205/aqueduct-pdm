import type { FaultClass } from "../types.ts";
import styles from "./FaultClassBadge.module.css";

/**
 * The fault class, as the thing an operator reads first.
 *
 * This badge is the visible output of the whole sensor-versus-equipment
 * discrimination, and it is the field that decides which van is dispatched: SENSOR
 * sends somebody with a reference probe, EQUIPMENT sends somebody to open the
 * machine. On the same reported symptom those two differ by 3.2 times in cost. Each
 * class gets its own colour so the distinction survives a glance down the column.
 *
 * AMBIGUOUS is styled deliberately flat, in grey rather than a warning colour. It is
 * a real and honest outcome — the instrumentation cannot decide this case — and
 * dressing it up as an alarm would push operators to treat it as one.
 */
const HINT: Record<FaultClass, string> = {
  sensor: "The measurement is wrong and the machine is not: a bias on one reading " +
    "reconciles every relation it appears in.",
  equipment: "The measurements agree with each other and the machine is what changed.",
  control: "An actuator is not following its command, which invalidates the other two " +
    "tests.",
  ambiguous: "The instrumentation cannot decide this case. Adding one relation " +
    "covering the suspect point would make it decidable.",
};

export function FaultClassBadge({ value }: { value: FaultClass }) {
  return (
    <span className={`${styles.badge} ${styles[value]}`} title={HINT[value]}>
      {value}
    </span>
  );
}
