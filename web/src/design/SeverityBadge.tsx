import styles from "./SeverityBadge.module.css";

/**
 * How bad it is, as a filled badge.
 *
 * FOUR TIERS, AND NEVER RED-AMBER-GREEN. Red, orange, gold, slate — from
 * DESIGN_SEMANTIC.md, and the reason is stated there: around eight per cent of men have
 * red-green colour deficiency, so a scale whose two ends are red and green has no ends
 * for one reader in twelve.
 *
 * COLOUR IS NEVER THE ONLY CARRIER. Every badge shows a text label AND a distinct
 * silhouette — triangle, diamond, square, circle — so the four stay separable in
 * greyscale, in print, and for anybody the hues collapse for. Removing either the label
 * or the shape puts the whole weight on hue, which is the thing this scale exists to
 * avoid depending on.
 *
 * HEALTH SCORES COME THROUGH HERE TOO. A health number quantises to the same four bands,
 * so the badge beside a score and the score itself cannot disagree.
 */

export type Tier = "critical" | "high" | "medium" | "low";

/** One silhouette per tier. Distinct in outline, not merely in colour. */
const SHAPE: Record<Tier, string> = {
  critical: "M6 1.5 11 10.5 1 10.5 Z", // triangle — the loudest outline
  high: "M6 1 11 6 6 11 1 6 Z", // diamond
  medium: "M1.75 1.75 H10.25 V10.25 H1.75 Z", // square
  low: "M6 1.4 A4.6 4.6 0 1 1 6 10.6 A4.6 4.6 0 1 1 6 1.4", // circle
};

const LABEL: Record<Tier, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function SeverityBadge({ tier, label }: { tier: Tier; label?: string }) {
  return (
    <span className={`${styles.badge} ${styles[tier]}`}>
      <svg viewBox="0 0 12 12" width={11} height={11} aria-hidden="true">
        <path d={SHAPE[tier]} fill="currentColor" />
      </svg>
      {label ?? LABEL[tier]}
    </span>
  );
}

/**
 * The band a health score falls in, as a tier.
 *
 * The mapping is the specification's: 85 and above healthy, 70 to 84 watch, 50 to 69
 * degraded, below 50 critical — onto low, medium, high, critical respectively. Note that
 * healthy is slate rather than green, which is the whole point of the scale.
 */
export function tierOfHealth(health: number): Tier {
  if (health >= 85) return "low";
  if (health >= 70) return "medium";
  if (health >= 50) return "high";
  return "critical";
}
