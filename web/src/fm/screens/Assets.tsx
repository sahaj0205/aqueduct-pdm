import { useNavigate } from "react-router-dom";

import { Panel } from "../../design/Panel.tsx";
import { ScreenHead } from "../../design/ScreenHead.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { HealthDot } from "../components/HealthDot.tsx";
import tableStyles from "../components/table.module.css";
import { getAssets } from "../data/client.ts";
import { useData } from "../data/useData.ts";
import { date } from "../lib/format.ts";

export function Assets() {
  const { data, loading, error } = useData(getAssets);
  const navigate = useNavigate();

  return (
    <div>
      <ScreenHead sub="Every piece of tracked plant, in one list.">All assets</ScreenHead>

      <Panel flush>
        {loading && <EmptyState title="Loading assets…" />}
        {error && <EmptyState title="Could not load assets">{error}</EmptyState>}
        {data && (
          <div className={tableStyles.wrap}>
            <div className={tableStyles.scroll}>
              <table className={tableStyles.table}>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Location</th>
                    <th>Health</th>
                    <th>Weakest mode</th>
                    <th>Open advisories</th>
                    <th>In service since</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((a) => (
                    <tr key={a.asset_id} className={tableStyles.clickable} onClick={() => navigate(`/fm/assets/${a.asset_id}`)}>
                      <td className={tableStyles.primary}>
                        {a.name}
                        <div style={{ color: "var(--ink-faint)", fontSize: 12 }}>{a.kind}</div>
                      </td>
                      <td>{a.location}</td>
                      <td>
                        <HealthDot health={a.health} band={a.band} />
                      </td>
                      <td className={tableStyles.faint}>{a.weakest_mode_label ?? "—"}</td>
                      <td className={tableStyles.num}>{a.open_advisories}</td>
                      <td className={tableStyles.faint}>{date(a.in_service)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
