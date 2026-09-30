// Reading the report's data: the embedded index, and each session's embedded data on demand.

import { useMemo } from "react";
import { INDEX_ELEMENT_ID, REPORT_VERSION, type ReportIndex, SESSION_ATTR } from "../../src/core/report-data.js";
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

const parsed = new Map<string, Session>();

/** A session's data, parsed from its embedded element the first time it's opened. */
function loadSession(key: string): Session {
  const done = parsed.get(key);
  if (done) return done;
  const el = [...document.querySelectorAll(`script[${SESSION_ATTR}]`)].find((e) => e.getAttribute(SESSION_ATTR) === key);
  if (!el?.textContent) throw new Error("This session's data is missing from the report. Generate it again.");
  const session = JSON.parse(el.textContent) as Session;
  parsed.set(key, session);
  return session;
}

export function useSession(key: string | undefined): { session?: Session; error?: string } {
  return useMemo(() => {
    if (!key) return {};
    try {
      return { session: loadSession(key) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [key]);
}
