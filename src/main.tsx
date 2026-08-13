import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installBrowserPreviewBridge } from "./previewBridge";
import "streamdown/styles.css";
import "./streamdown.css";
import "./styles.css";

installBrowserPreviewBridge();

/** Show custom scrollbars only while an element is actively scrolling. */
const scrollHideTimers = new WeakMap<Element, number>();
document.addEventListener(
  "scroll",
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    target.classList.add("is-scrolling");
    const previous = scrollHideTimers.get(target);
    if (previous !== undefined) window.clearTimeout(previous);
    scrollHideTimers.set(
      target,
      window.setTimeout(() => {
        target.classList.remove("is-scrolling");
        scrollHideTimers.delete(target);
      }, 900),
    );
  },
  { capture: true, passive: true },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
