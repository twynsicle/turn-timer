import { listProjects, listSessions } from "./discover.js";
import { projectsDir } from "./paths.js";
import type { ProjectInfo, SessionInfo } from "./types.js";

/** Resolve a project by 1-based listing index, folder name, or case-insensitive cwd fragment. */
export async function resolveProject(ref: string, root = projectsDir()): Promise<ProjectInfo> {
  const projects = await listProjects(root);
  if (/^\d+$/.test(ref)) {
    const p = projects[Number(ref) - 1];
    if (p) return p;
  }
  const exact = projects.find((p) => p.dir === ref || p.cwd.toLowerCase() === ref.toLowerCase());
  if (exact) return exact;
  const needle = ref.toLowerCase();
  const matches = projects.filter((p) => p.cwd.toLowerCase().includes(needle) || p.dir.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0]!;
  // Prefer a match on the last path segment ("Alien Loot" over "Alien Loot/.claude/worktrees/x").
  const tail = matches.filter((p) => (p.cwd.split(/[\\/]/).pop() ?? "").toLowerCase().includes(needle));
  if (tail.length === 1) return tail[0]!;
  if (!matches.length) throw new Error(`No project matches "${ref}". Run \`turn-timer projects\` to list them.`);
  throw new Error(`"${ref}" matches ${matches.length} projects:\n${matches.map((p) => `  ${p.cwd}`).join("\n")}`);
}

/**
 * Resolve a session by 1-based index (within a project), "latest", id prefix, or title /
 * first-prompt fragment. Without a project, id prefixes are searched across all projects.
 */
export async function resolveSession(ref: string, projectRef?: string, root = projectsDir()): Promise<SessionInfo> {
  const projects = projectRef ? [await resolveProject(projectRef, root)] : await listProjects(root);
  if (!projectRef && (/^\d+$/.test(ref) || ref === "latest")) {
    throw new Error("Session index or \"latest\" needs a project: use --project <name>.");
  }
  const candidates: SessionInfo[] = [];
  for (const p of projects) candidates.push(...(await listSessions(p.dir, root)));
  if (ref === "latest" && candidates[0]) return candidates[0];
  if (/^\d+$/.test(ref) && candidates[Number(ref) - 1]) return candidates[Number(ref) - 1]!;
  const byId = candidates.filter((s) => s.id.startsWith(ref));
  if (byId.length === 1) return byId[0]!;
  const needle = ref.toLowerCase();
  const byText = candidates.filter(
    (s) => s.title?.toLowerCase().includes(needle) || s.firstPrompt?.toLowerCase().includes(needle),
  );
  const found = byId.length ? byId : byText;
  if (found.length === 1) return found[0]!;
  if (!found.length) throw new Error(`No session matches "${ref}".`);
  throw new Error(
    `"${ref}" matches ${found.length} sessions:\n${found
      .slice(0, 10)
      .map((s) => `  ${s.id.slice(0, 8)}  ${s.title ?? s.firstPrompt ?? ""}`.slice(0, 100))
      .join("\n")}`,
  );
}
