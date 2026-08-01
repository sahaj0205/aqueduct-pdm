import { Navigate, Route, Routes } from "react-router-dom";

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
 *
 * THIS PLATFORM USED TO BE DARK AND NO LONGER IS. It shipped with its own palette —
 * a slate navy borrowed from the deck, scoped to a `data-fm-theme="dark"` attribute this
 * component set on <html> while mounted, plus a mirrored copy of every chart colour as
 * literal hex for SVG. The reasoning was that the deck and the platform are shown in the
 * same darkened room, so they should not be two different colours of dark.
 *
 * That reasoning was about the presenter's room, and it cost the thing that actually
 * matters: a visitor arriving from the front door walked out of a white product page into
 * a dark application and read it as a different piece of software. The platform is the
 * product this project is selling, and the front door is where it is sold — those two
 * surfaces have to look like one company. So the override is gone entirely and the
 * platform inherits design/tokens.css like every other screen.
 *
 * NOTHING HAD TO BE REPAINTED TO DO IT. Every one of the platform's stylesheets was
 * already written against custom properties with not a single hardcoded colour among
 * them, and all fifty-four values the dark file set were overrides of tokens that already
 * existed. Deleting the file was the whole change; the charts followed via the one
 * re-export in fm/lib/chartTheme.ts.
 */
export function FmApp() {
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
