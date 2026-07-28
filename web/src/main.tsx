import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.tsx";

// Self-hosted rather than fetched from a font CDN: this runs behind nginx on a box that
// should not need to reach the public internet to render its own type, and a demo that
// falls back to Times because a CDN is slow is a demo that has lost its voice.
// Cormorant Garamond, not EB Garamond: the licensed display face this stands in for is
// used at weight 300, and EB Garamond's lightest cut is 400 — asking a browser for a
// weight a family does not have gets a synthetically thinned one, which on a serif looks
// exactly as bad as it sounds. Cormorant ships a genuine Light and is a Garamond revival,
// so the substitution is a like-for-like one.
// Inter at weight 300 stands in for the proprietary display face this language
// specifies; the negative tracking in tokens.css does the rest of the work. Only two
// weights are needed — 300 for display and body, 400 for buttons and captions — because
// thin IS the brand and anything heavier collapses its editorial air. Self-hosted rather
// than fetched from a font CDN, and Latin subsets only.
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

// BrowserRouter rather than HashRouter: these are real paths, so a deployment can
// serve /twin directly and a pasted link has no # in it. The cost is that whatever
// serves the built files has to fall back to index.html on an unknown path -- the Vite
// dev server does that already, and it is one line in any static host.
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
