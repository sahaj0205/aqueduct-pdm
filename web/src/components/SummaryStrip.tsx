import { healthBand, usd } from "../lib/format.ts";
import { Bridge } from "../design/Bridge.tsx";
import { Stat, Unit } from "../design/Stat.tsx";
import { Term } from "../design/Term.tsx";
import type { FaultClass, SiteSummary } from "../types.ts";
import { FaultClassBadge } from "./FaultClassBadge.tsx";
import styles from "./SummaryStrip.module.css";

/**
 * The two numbers a manager asks about first, and the gap between them.
 *
 * WHAT THIS USED TO BE. Seven equal cells in a grey grid — assets, advisories, worst
 * health, cost of inaction, cost to act, unpriced, fault classes — every one of them the
 * same size, in the same colour, in the same nineteen-pixel monospace. Everything on the
 * strip was equally loud, which means none of it was loud, and the reader had to decide
 * for themselves which of the seven mattered. Two of them did.
 *
 * THE BRIDGE IS THE WHOLE COMPONENT. What does doing nothing cost, what does fixing it
 * cost, and how far apart are they. That ratio is the argument for the existence of this
 * entire system, and it was previously something the reader had to work out by eye from
 * two numbers in adjacent boxes. It is now stated.
 *
 * THE CAVEAT TRAVELS WITH THE NUMBER. Both totals are sums over the advisories that
 * could be priced, and some cannot be. That is not a footnote at the bottom of the
 * screen; it is in the caption under the figure it qualifies, and the count of unpriced
 * work sits in the row below. A total that quietly excluded rows would be the easiest
 * misrepresentation on this page.
 */

interface Props {
  summary: SiteSummary;
  /** Asset id to human name, so the worst-health machine is named rather than coded. */
  assetNames: Record<string, string>;
}

/** Coarse where it is large, precise where it is small. 22× and 1.4× both read right. */
function ratioLabel(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * The gap between doing nothing and doing the work, stated in whichever direction is
 * actually true.
 *
 * WHY THIS IS NOT JUST inaction / effort. It was, and on the first run of real data it
 * printed "0.0× dearer to ignore than to fix" — because at that moment the queue held two
 * chiller jobs costing thirty-five thousand dollars to do against two hundred and
 * twenty-seven dollars of expected waste from leaving them alone. The ratio was 0.006,
 * and rounding it to one decimal produced a zero that looked like a broken feed.
 *
 * Worse than looking broken, the sentence was backwards. So the comparison is computed in
 * whichever direction is greater than one, and says which direction that is. Both regimes
 * happen here and both are real: a leaking valve on an air handler is far cheaper to fix
 * than to tolerate, and a chiller whose failure date the model refuses to bound has
 * almost no priced consequence to weigh a full overhaul against.
 */
function bridge(
  inaction: number,
  effort: number,
): { label: string; note: string; alarming: boolean } | null {
  if (inaction <= 0 || effort <= 0) return null;
  if (inaction >= effort) {
    return {
      label: ratioLabel(inaction / effort),
      note: "dearer to ignore\nthan to fix",
      alarming: true,
    };
  }
  return {
    label: ratioLabel(effort / inaction),
    note: "dearer to fix\nthan to ignore",
    alarming: false,
  };
}

export function SummaryStrip({ summary, assetNames }: Props) {
  const band = healthBand(summary.worst_health);
  const classes = Object.entries(summary.by_class) as [FaultClass, number][];

  const inaction = summary.total_cost_of_inaction_usd;
  const effort = summary.total_effort_usd;
  // Null rather than assumed: an all-unpriced queue sums to zero on both sides, and
  // dividing by it would print Infinity× as though it were a finding.
  const gap = bridge(inaction, effort);

  const worstAsset = summary.worst_health_asset;
  const worstName = worstAsset ? (assetNames[worstAsset] ?? worstAsset) : null;

  return (
    <>
      <Bridge
        ratio={
          gap && { label: gap.label, note: gap.note, alarming: gap.alarming }
        }
        footnote={
          /* Only when the arithmetic runs the other way. The claim is checked against
             analytics/advisories/generate.py: the failure term is computed from the
             published prediction interval and `probability_by` returns nothing at all
             when that interval is unbounded, so an unbounded prediction leaves the
             energy term as the only priced consequence. Energy is held flat at today's
             severity rather than projected along the trend, which understates an
             accelerating fault — stated here because it is the reason a small number is
             not a safe number. */
          gap && !gap.alarming ? (
            <>
              On expected cost alone this queue does not yet pay for itself, and that is a
              finding rather than missing data. The failure itself is priced only where
              the model will bound a date for it; where it will not, the one priced
              consequence is wasted energy, held flat at today&rsquo;s severity rather
              than projected along the trend. A small number here is not a safe number —
              the rows below say which is which.
            </>
          ) : undefined
        }
        left={
          <Stat
            size="hero"
            // Tone follows the arithmetic, not the label. Two hundred dollars of
            // expected waste printed in alarm red would be the strip shouting about
            // nothing.
            tone={gap?.alarming ? "alarm" : "neutral"}
            label="If nothing is done"
            value={usd(inaction)}
            caption={
              <>
                over the next {Math.round(summary.horizon_days)} days — wasted energy plus
                the priced chance of the failure itself. See{" "}
                <Term id="cost-of-inaction">cost of inaction</Term>.
              </>
            }
          />
        }
        right={
          <Stat
            size="hero"
            label="To fix all of it"
            value={usd(effort)}
            caption={
              <>
                labour and parts across every job that could be priced
                {summary.unpriced > 0 && (
                  <>
                    {" "}
                    — <strong>{summary.unpriced}</strong> could not be, and{" "}
                    {summary.unpriced === 1 ? "is" : "are"} excluded from both totals
                  </>
                )}
              </>
            }
          />
        }
      />

      {/* Everything else. Deliberately quieter than the two figures above: these are
          context for the money, not competitors with it. */}
      <section className={styles.facts}>
        <Stat
          label="Worst machine"
          tone={band === "bad" ? "alarm" : band === "warn" ? "caution" : "neutral"}
          value={
            summary.worst_health === null ? (
              "none scored"
            ) : (
              <>
                {summary.worst_health}
                <Unit>/ 100</Unit>
              </>
            )
          }
          caption={worstName ?? "nothing has a health score yet"}
        />

        <Stat
          label="Open jobs"
          value={summary.advisories}
          caption={
            summary.consequential > 0 ? (
              <>
                {summary.consequential}{" "}
                <Term id="consequential">consequential</Term> — fixing the cause removes{" "}
                {summary.consequential === 1 ? "it" : "them"}
              </>
            ) : (
              "none is a knock-on effect of another"
            )
          }
        />

        <Stat
          label="Machines watched"
          value={summary.assets}
          caption="every one modelled from the building's own semantic description"
        />

        <div className={styles.classCell}>
          <span className={styles.classLabel}>
            <Term id="fault-class">Where the blame lands</Term>
          </span>
          <div className={styles.classes}>
            {classes.length === 0 ? (
              <span className={styles.none}>nothing open</span>
            ) : (
              classes.map(([name, count]) => (
                <span key={name} className={styles.classRow}>
                  <FaultClassBadge value={name} />
                  <span className={styles.classCount}>{count}</span>
                </span>
              ))
            )}
          </div>
          <span className={styles.classNote}>
            it decides which van goes out, and the two cost differently
          </span>
        </div>
      </section>

      {/* The vintage matters more here than in most systems. This database holds several
          independent simulation runs in separate calendar eras, so "now" is not a single
          instant, and the health figures above are quoted as of the window each asset's
          own advisories were computed over. Stating when the queue was generated stops
          the screen implying it is live. */}
      <p className={styles.vintage}>
        Queue computed{" "}
        {summary.generated_at
          ? new Date(summary.generated_at).toLocaleString()
          : "never — run make advisory-replay"}
        . Health is quoted as of each machine&rsquo;s own advisory window, not wall-clock
        now — see <Term id="vintage">vintage</Term>.
      </p>
    </>
  );
}
