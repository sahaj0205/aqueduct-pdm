import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API is reached through a dev-server proxy on a same-origin path rather than by
// pointing the browser at http://localhost:8000 directly. Two reasons: the frontend
// code then contains no hostname at all, so a deployment behind one origin needs no
// rebuild, and no browser request is ever cross-origin, so CORS cannot be what breaks
// the dashboard. The CORS middleware in the API stays as a second line for anyone who
// does hit it directly from a browser.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // The reveal service is a second process on a second credential, so it gets a
      // second proxy path rather than being merged behind /api. Keeping the split
      // visible in the URL is the point: a request to /reveal is a request for the
      // answer key, and that should be obvious in a browser's network tab.
      "/reveal": {
        target: "http://127.0.0.1:8002",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/reveal/, ""),
      },
    },
  },
});
