import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // Keep the browser bundle separate from the Node dashboard/server output.
  build: { outDir: "../../../dist/dashboard-client", emptyOutDir: true },
  server: { port: 5174, proxy: { "/api": "http://127.0.0.1:3001" } },
});
