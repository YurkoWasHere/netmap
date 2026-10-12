import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api goes to the netmap server (npm start in ../server).
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { proxy: { "/api": "http://127.0.0.1:8090" } }
});
