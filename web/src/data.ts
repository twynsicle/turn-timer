// Reading the report's data: the embedded index, and each session's file on demand.

import { useEffect, useState } from "react";
import { INDEX_ELEMENT_ID, REPORT_VERSION, type ReportIndex, SESSIONS_DIR, SESSION_CALLBACK, type SessionData } from "../../src/core/report-data.js";
import type { Session } from "../../src/core/types.js";

export function readIndex(): ReportIndex | { error: string } {
  const text = document.getElementById(INDEX_ELEMENT_ID)?.textContent;
  if (!text?.trim()) return { error: "This page has no session data. Generate a report with `claude-sessions`." };
  try {
    const index = JSON.parse(text) as ReportIndex;
    if (index.version !== REPORT_VERSION) return { error: "This report was made by a different version of claude-sessions. Generate it again." };
    return index;
  } catch (e) {
    return { error: `The session data is unreadable: ${(e as Error).message}` };
  }
}

const loaded = new Map<string, Session>();
const waiting = new Map<string, { resolve: (s: Session) => void; reject: (e: Error) => void }[]>();

(window as unknown as Record<string, unknown>)[SESSION_CALLBACK] = (data: SessionData) => {
  loaded.set(data.key, data.session);
  for (const w of waiting.get(data.key) ?? []) w.resolve(data.session);
  waiting.delete(data.key);
};

/**
 * Load `sessions/<key>.js` with a script tag: fetch() can't read files next to a page opened
 * from file://, but a script can, and it hands its data to SESSION_CALLBACK.
 */
function loadSession(key: string): Promise<Session> {
  const done = loaded.get(key);
  if (done) return Promise.resolve(done);
  return new Promise((resolve, reject) => {
    const list = waiting.get(key);
    if (list) return list.push({ resolve, reject });
    waiting.set(key, [{ resolve, reject }]);
    const script = document.createElement("script");
    script.src = `${SESSIONS_DIR}/${encodeURIComponent(key)}.js`;
    script.onerror = () => {
      for (const w of waiting.get(key) ?? []) w.reject(new Error(`Couldn't load ${script.src}. The report folder may have been moved or regenerated.`));
      waiting.delete(key);
      script.remove();
    };
    document.head.appendChild(script);
  });
}

export function useSession(key: string | undefined): { session?: Session; error?: string } {
  const [state, setState] = useState<{ key?: string; session?: Session; error?: string }>({});
  useEffect(() => {
    if (!key) return;
    let live = true;
    loadSession(key).then(
      (session) => live && setState({ key, session }),
      (e: Error) => live && setState({ key, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state.key === key ? state : {};
}
