import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthGate } from "./AuthGate";
import { normalizeLocation } from "./routes";
import "./styles.css";

// Canonical page URL before anything renders (incl. the sign-in screen); see routes.ts.
normalizeLocation();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
