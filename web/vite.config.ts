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
    },
  },
});
