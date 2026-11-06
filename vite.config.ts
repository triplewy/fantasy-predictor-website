import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages serves the site from /<repo-name>/, so built asset URLs need that prefix.
  // The dev server keeps "/" so localhost works as before.
  base: command === "build" ? "/fantasy-predictor-website/" : "/",
}));
