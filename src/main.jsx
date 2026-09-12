import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AdminApp from "./AdminApp.jsx";
import "./styles/global.css";
import "./styles/admin.css";

const RootApp = window.location.pathname.replace(/\/$/, "") === "/admin" ? AdminApp : App;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
