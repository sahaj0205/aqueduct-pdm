import { SeverityBadge } from "../../design/SeverityBadge.tsx";
import { BAND_LABEL, tierOfBand } from "../lib/format.ts";
import type { HealthBand } from "../types.ts";
import styles from "./HealthDot.module.css";

/** A health number with its band, as one compact unit for tables and cards. */
export function HealthDot({ health, band }: { health: number | null; band: HealthBand | null }) {
  if (health === null || band === null) {
    return (
      <span className={styles.wrap}>
        <span className={styles.band}>not tracked</span>
      </span>
    );
  }
  return (
    <span className={styles.wrap}>
      <span className={styles.value}>{Math.round(health)}</span>
      <SeverityBadge tier={tierOfBand(band)} label={BAND_LABEL[band]} />
    </span>
  );
}
