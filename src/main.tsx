import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installFrontendLogging } from "./lib/logger";
import { initI18n } from "./i18n";

// Check if this window was opened as a detached DevLog view
const params = new URLSearchParams(window.location.search);
const view = params.get("view");

if (view === "captions") {
  // Caption strip: make the page see-through before i18n resolves so no opaque
  // frame flashes while the window initializes.
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

installFrontendLogging();

function render() {
  if (view === "meeting-prompt") {
    // Meeting detection prompt: its own tiny root, none of the app's hooks
    // (global shortcuts, config sync) run in this window.
    import("./meeting-prompt/MeetingPrompt").then(({ MeetingPromptWindow }) => {
      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <MeetingPromptWindow />
        </React.StrictMode>
      );
    });
  } else if (view === "captions") {
    // Caption strip: its own small root too. The page is see-through, so only
    // what the strip draws covers the meeting underneath.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    import("./captions/CaptionsWindow").then(({ CaptionsWindow }) => {
      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <div className="h-screen w-screen overflow-hidden">
            <CaptionsWindow />
          </div>
        </React.StrictMode>
      );
    });
  } else if (view === "devlog") {
    // Render only the DevLog in this window — it subscribes to Tauri events
    // independently and reads from the shared devLogStore.
    import("./components/DevLogPanel").then(({ DevLogFullPage }) => {
      // The detached window also needs its own event subscription
      import("./hooks/useDevLog").then(({ useDevLog }) => {
        // Wrapper component that runs the useDevLog hook
        function DevLogWindow() {
          useDevLog();
          return <DevLogFullPage />;
        }
        ReactDOM.createRoot(document.getElementById("root")!).render(
          <React.StrictMode>
            <DevLogWindow />
          </React.StrictMode>
        );
      });
    });
  } else {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  }
}

// Translations are ready before the first render, in every window.
initI18n()
  .catch((err) => console.error("[i18n] Failed to initialize translations:", err))
  .finally(render);
