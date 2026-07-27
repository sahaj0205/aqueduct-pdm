import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.tsx";
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
