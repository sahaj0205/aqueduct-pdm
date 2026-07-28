import type { TwinNode, TwinState } from "../types.ts";
import styles from "./NodeInspector.module.css";

/**
 * Every instrument on one node, with what it reads now and what it should read.
 *
 * This is where the twin stops being a picture and becomes the model: a node is not a
 * coloured box, it is a set of named instruments with units, and clicking it should
 * show them rather than a summary of them.
 *
 * THREE COLUMNS THAT ARE NOT THE SAME NUMBER, and the distinction is the point. `now`
 * is an hourly average from the rollup. `expected` and the drift beside it come from a
 * fitted baseline evaluated on one five-minute sample, so the raw sample is shown
 * alongside — subtracting `expected` from `now` gives a third answer that is not the
 * residual. Most rows have no expectation at all, and say so.
 */

interface Props {
  node: TwinNode;
  state: TwinState | null;
  onClose: () => void;
}

function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 10000) return value.toExponential(2);
  return value.toFixed(digits);
}

export function NodeInspector({ node, state, onClose }: Props) {
  const rows = node.points.map((point) => ({
    point,
    live: point.point_id ? state?.points[point.point_id] : undefined,
  }));
  const asset = node.asset_id ? state?.assets[node.asset_id] : undefined;
  const withBaseline = rows.filter((r) => r.live?.sigma !== null && r.live?.sigma !== undefined);

  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <div>
          <h3>{node.label}</h3>
          <span className={styles.muted}>
            {node.brick_class}
            {node.asset_id ? ` · ${node.asset_id}` : " · not a database asset"}
            {node.parent && ` · inside ${node.parent.replace(/_/g, " ")}`}
          </span>
        </div>
        <button className={styles.close} onClick={onClose}>
          close
        </button>
      </div>

      {asset && (
        <div className={styles.condition}>
          <span>
            health <strong>{asset.health ?? "—"}</strong>
            {asset.weakest_mode && ` · weakest ${asset.weakest_mode}`}
          </span>
          <span>
            {asset.rul_p50 !== null ? (
              <>
                remaining life <strong>{Math.round(asset.rul_p50)} days</strong>
                {asset.rul_p10 !== null && asset.rul_p90 !== null && (
                  <> ({Math.round(asset.rul_p10)}–{Math.round(asset.rul_p90)})</>
                )}
                {asset.rul_mode && ` · ${asset.rul_mode}`}
              </>
            ) : (
              // A refusal is an answer and is printed as one, not left blank.
              <span className={styles.muted}>
                the model declines to bound a remaining life here
              </span>
            )}
          </span>
          <span className={styles.muted}>
            {asset.open_advisories} open advisor
            {asset.open_advisories === 1 ? "y" : "ies"}
          </span>
        </div>
      )}

      {node.points.length === 0 ? (
        <p className={styles.muted}>
          Nothing is measured on this node. Both water loops are like this: they are how
          the model represents flow between machines, not machines.
        </p>
      ) : (
        <>
          {/* Six columns of numbers in a 400px side panel. The table scrolls inside
              itself rather than forcing the column it sits in to widen. */}
          <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>reading</th>
                <th className={styles.r}>now</th>
                <th className={styles.r}>sample</th>
                <th className={styles.r}>expected</th>
                <th className={styles.r}>drift</th>
                <th>unit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ point, live }) => (
                <tr key={point.graph_name}>
                  <td>
                    <div>{point.name ?? point.graph_name}</div>
                    <div className={styles.sub}>
                      {point.point_id ?? (
                        <em>declared in the model, never a stored column</em>
                      )}
                    </div>
                  </td>
                  <td className={styles.r}>{num(live?.value)}</td>
                  <td className={styles.r}>{num(live?.observed)}</td>
                  <td className={styles.r}>
                    {live?.expected === null || live?.expected === undefined ? (
                      <span className={styles.muted}>no baseline</span>
                    ) : (
                      num(live.expected)
                    )}
                  </td>
                  <td className={styles.r}>
                    {live?.sigma === null || live?.sigma === undefined ? (
                      "—"
                    ) : (
                      <strong
                        className={
                          Math.abs(live.sigma) >= 3
                            ? styles.bad
                            : Math.abs(live.sigma) >= 2
                              ? styles.warn
                              : undefined
                        }
                      >
                        {live.sigma.toFixed(2)}σ
                      </strong>
                    )}
                  </td>
                  <td className={styles.muted}>{point.unit_si ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className={styles.note}>
            <strong>{withBaseline.length} of {rows.length}</strong> readings here carry a
            fitted expectation. <em>now</em> is an hourly average; <em>sample</em> is the
            five-minute reading the baseline was evaluated against, so{" "}
            <em>sample − expected</em> is the drift and <em>now − expected</em> is not.
          </p>
        </>
      )}
    </section>
  );
}
