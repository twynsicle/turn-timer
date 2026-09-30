import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { readIndex } from "./data.js";
import "./styles.css";

const index = readIndex();
createRoot(document.getElementById("root")!).render(
  <StrictMode>{"error" in index ? <div className="notice tone-risk page-error">{index.error}</div> : <App index={index} />}</StrictMode>,
);
