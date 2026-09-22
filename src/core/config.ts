// Tunable classification rules. Pure (no Node imports) so the web viewer can share it.

export interface Config {
  /** Tools that only read state. Calls to these are independent unless one uses another's result. */
  readOnlyTools: string[];
  /** Tools that modify files; batchable with each other when they touch different files. */
  editTools: string[];
  /** Tools that run shell commands; read-only when every command segment is in readOnlyCommands. */
  execTools: string[];
  /** Tools that spawn subagents. */
  agentTools: string[];
  /** Shell commands (first word, or first two words like "git status") considered read-only. */
  readOnlyCommands: string[];
  /** How many turns back to look for a result that a call depends on. */
  dependencyLookback: number;
}

export const DEFAULT_CONFIG: Config = {
  readOnlyTools: [
    "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead", "LSP",
    "ToolSearch", "TaskOutput", "TaskList", "TaskGet",
  ],
  editTools: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
  execTools: ["Bash", "PowerShell"],
  agentTools: ["Agent", "Task"],
  readOnlyCommands: [
    // POSIX
    "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "file", "stat", "pwd", "echo",
    "which", "tree", "du", "df", "type", "less", "sort", "uniq", "cut", "diff", "realpath",
    "dirname", "basename", "true", "cd", "printf", "date", "env", "whoami", "uname",
    "awk", "jq", "tr", "nl", "column", "xxd", "od", "strings", "md5sum", "sha256sum", "ps",
    "hostname", "test", "readlink",
    // git (read-only subcommands)
    "git status", "git log", "git diff", "git show", "git branch", "git rev-parse",
    "git ls-files", "git blame", "git remote", "git describe", "git tag", "git reflog",
    "git config --get", "git worktree list", "git stash list", "git shortlog",
    "gh pr view", "gh pr list", "gh pr diff", "gh pr checks", "gh issue view", "gh issue list",
    "gh run view", "gh run list",
    // PowerShell
    "Get-ChildItem", "gci", "dir", "Get-Content", "gc", "Select-String", "sls", "Test-Path",
    "Get-Item", "gi", "Get-Location", "Resolve-Path", "Measure-Object", "Select-Object",
    "Where-Object", "Sort-Object", "Format-Table", "Format-List", "Get-Command",
    "Get-Process", "Get-Date", "Write-Output", "Out-String", "ForEach-Object", "Split-Path",
    "Join-Path", "Get-FileHash", "ConvertFrom-Json", "Set-Location",
    // version checks
    "node --version", "npm --version", "python --version", "npm ls", "npm view",
  ],
  dependencyLookback: 5,
};

export function mergeConfig(partial: Partial<Config> | undefined): Config {
  return { ...DEFAULT_CONFIG, ...(partial ?? {}) };
}
