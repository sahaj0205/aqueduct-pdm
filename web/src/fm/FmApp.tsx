import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import "./theme.css";
import { ToastProvider } from "./components/Toast.tsx";
import { Shell } from "./Shell.tsx";
import { Advisory } from "./screens/Advisory.tsx";
import { AssetDetail } from "./screens/AssetDetail.tsx";
import { Assets } from "./screens/Assets.tsx";
import { Instruments } from "./screens/Instruments.tsx";
import { Overview } from "./screens/Overview.tsx";
import { Record } from "./screens/Record.tsx";
import { Schedule } from "./screens/Schedule.tsx";
import { Worklist } from "./screens/Worklist.tsx";

/**
 * The facility-manager platform's route table, mounted independently of the console
 * at `/console` — see App.tsx for the one-line branch that hands `/fm` off here.
 */
export function FmApp() {
  // Set on <html> rather than on a wrapper element, so the toast stack and any
  // portalled overlay — both of which render outside this subtree — are themed too.
  // Removed on unmount, which is what leaves the console at "/" and "/console" in its
  // original light theme.
  useEffect(() => {
    document.documentElement.dataset.fmTheme = "dark";
    return () => {
      delete document.documentElement.dataset.fmTheme;
    };
  }, []);

  return (
    <ToastProvider>
      <Routes>
        <Route path="/fm" element={<Shell />}>
          <Route index element={<Overview />} />
          <Route path="worklist" element={<Worklist />} />
          <Route path="worklist/:advisoryId" element={<Advisory />} />
          <Route path="assets" element={<Assets />} />
          <Route path="assets/:assetId" element={<AssetDetail />} />
          <Route path="schedule" element={<Schedule />} />
          <Route path="instruments" element={<Instruments />} />
          <Route path="record" element={<Record />} />
          <Route path="*" element={<Navigate to="/fm" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
