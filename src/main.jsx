import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import AdminApp from "./AdminApp.jsx";
import ResearchHistoryPage from "./components/admin/ResearchHistory.jsx";
import "./styles/global.css";
import "./styles/admin.css";

const path = window.location.pathname.replace(/\/$/, "");
const RootApp = path === "/admin/research" ? ResearchHistoryPage : path === "/admin" ? AdminApp : App;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
