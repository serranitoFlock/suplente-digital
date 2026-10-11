import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Static write guard for registered scripts: an extra safety net, NOT the authorization.
 *
 * A script runs only because a human registered it with `readOnly: true`. This guard is a heuristic
 * that scans the command line and the script files it points to for obvious write operations, and can
 * only REJECT an entry: passing it never makes a script read-only or allowed. It has false positives
 * (a comment that mentions `git push` rejects the script) and false negatives (a binary, an obfuscated
 * call or a write through an API it does not know); both are acceptable for a reject-only check.
 */

export interface WriteFinding {
  /** Pattern family, e.g. `http-write` or `git-write`. */
  family: string;
  /** The matched text (trimmed), for the warning shown to the human who registered the script. */
  match: string;
}

export interface GuardFinding extends WriteFinding {
  /** Where it was found: `command line` or the repo-relative path of a scanned file. */
  source: string;
}

interface WritePattern {
  family: string;
  pattern: RegExp;
  /** Only meaningful in shell text (command lines and shell scripts), e.g. `>` redirection. */
  shellOnly?: boolean;
}

/** Every write pattern, in one place. Add new families here; each one can only reject. */
const WRITE_PATTERNS: WritePattern[] = [
  // Explicit HTTP verbs on curl/wget/httpie/`gh api` (`-X POST`, `--request PUT`, `--method PATCH`): only a literal
  // GET or HEAD passes, so a verb built at runtime (`--request "$M"`, `-X $VERB`) counts as a write. No `i` flag:
  // `[A-Z]` must not match the lowercase JVM-style `-Xmx512m`.
  {
    family: "http-write",
    pattern: /(?:^|\s)(?:-X|--request|--method)(?:\s+|=|(?=['"$A-Z]))(?!['"]?(?:[Gg][Ee][Tt]|[Hh][Ee][Aa][Dd])['"]?(?=\s|$))\S+/gm,
  },
  // Request bodies and uploads imply a write: curl -d/--data*/-F/--form*/-T/--upload-file/--json, wget --post-*.
  { family: "http-body-upload", pattern: /\bcurl\b[^\n]*?\s(?:-[a-zA-Z]*[dFT](?=[\s'"=@]|$)|--(?:data[\w-]*|form[\w-]*|upload-file|json)\b)/gm },
  { family: "http-body-upload", pattern: /\bwget\b[^\n]*?\s--(?:post-data|post-file|body-data|body-file|method)\b/gm },
  // HTTP clients in code: fetch/axios options, requests/axios/httpx helpers.
  { family: "http-client-write", pattern: /\bmethod\s*[:=]\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]/gi },
  { family: "http-client-write", pattern: /\b(?:requests|axios|httpx|session|got|ky|superagent|http)\s*\.\s*(?:post|put|patch|delete)\s*\(/gi },
  { family: "http-client-write", pattern: /\.request\(\s*['"](?:POST|PUT|PATCH|DELETE)['"]/gi },
  // Git commands that change a repository (local or remote).
  { family: "git-write", pattern: /\bgit\b[^\n|;&]*?\s(?:push|commit|merge|rebase|reset|tag|clean|cherry-pick|revert|rm|mv|pull|stash|restore|checkout|switch)\b/gm },
  // Deleting, moving or creating files from the shell.
  { family: "file-delete-move", pattern: /(?:^|[\s;&|(`])(?:rm|rmdir|mv|cp|unlink|shred|truncate|touch|chmod|chown|ln|mkdir|dd)\s/gm },
  // Writing files from code (Node fs, Python open/os/shutil).
  { family: "file-write-api", pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdirSync|renameSync|mkdirSync|copyFile|copyFileSync)\s*\(/g },
  { family: "file-write-api", pattern: /\bopen\s*\([^)\n]*,\s*['"][^'"]*[wax+][^'"]*['"]/g },
  { family: "file-write-api", pattern: /\b(?:os\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)|shutil\.\w+)\s*\(/g },
  // Shell redirection to a file (`>`, `>>`, `>|`, `1>`); `>&2`, `2>&1`, `>/dev/null` and `2>/dev/null` are allowed.
  { family: "shell-redirect", pattern: /(?:^|[\s;&|(])\d?>(?:>|\|)?(?![>&=])[ \t]*(?!\/dev\/null\b)[^\s&|;)]/gm, shellOnly: true },
  // GitLab/GitHub CLIs: mutating subcommands, `ci|workflow run`, and `api` with fields (implies POST).
  {
    family: "cli-mutation",
    pattern:
      /\b(?:gh|glab)\b[^\n|;&]*?\s(?:retry|cancel|delete|create|merge|close|reopen|approve|unapprove|revoke|edit|comment|note|rerun|trigger|update|lock|unlock|transfer|archive|play|erase|enable|disable)\b/gm,
  },
  { family: "cli-mutation", pattern: /\b(?:gh|glab)\b[^\n|;&]*?\s(?:ci|workflow|pipeline)\s+run\b/gm },
  { family: "cli-mutation", pattern: /\b(?:gh|glab)\s+api\b[^\n|;&]*?\s(?:-f|-F|--field|--raw-field|--input)(?=[\s=]|$)/gm },
  // Publishing packages.
  { family: "package-publish", pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate|dist-tag)\b/g },
  // Changing a cluster.
  {
    family: "cluster-write",
    pattern: /\bkubectl\b[^\n|;&]*?\s(?:apply|delete|create|patch|replace|scale|edit|rollout|set|label|annotate|drain|cordon|uncordon|taint|expose|run|exec|cp)\b/gm,
  },
  { family: "cluster-write", pattern: /\bhelm\s+(?:install|upgrade|uninstall|rollback|delete)\b/g },
  // Editing files in place or copying output to files.
  { family: "in-place-edit", pattern: /\b(?:sed|perl)\b[^\n|;&]*?\s(?:-[a-zA-Z]*i|--in-place)/gm },
  { family: "in-place-edit", pattern: /(?:^|[\s|;&(])tee(?:\s|$)/gm },
];

/** Scans text for write operations; `shell` also checks shell-only families (redirection). */
export function findWriteOperations(text: string, { shell = true }: { shell?: boolean } = {}): WriteFinding[] {
  const findings: WriteFinding[] = [];
  for (const { family, pattern, shellOnly } of WRITE_PATTERNS) {
    if (shellOnly && !shell) continue;
    for (const match of text.matchAll(pattern)) findings.push({ family, match: match[0].trim() });
  }
  return findings;
}

const MAX_SCANNED_BYTES = 512 * 1024;
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;
const isShellFile = (path: string, text: string) => /\.(?:sh|bash|zsh|ksh)$/.test(path) || /^#!.*\b(?:ba|z|da|k)?sh\b/.test(text);

/** Absolute path of an existing file inside `root`, or undefined. */
async function repoFile(candidate: string, base: string, root: string): Promise<string | undefined> {
  if (!candidate || isAbsolute(candidate) || candidate.includes("{")) return undefined;
  const path = resolve(base, candidate);
  const rel = relative(root, path);
  if (rel === "" || rel.split(sep)[0] === ".." || isAbsolute(rel)) return undefined;
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? path : undefined;
}

export interface GuardInput {
  command: string;
  argv: readonly string[];
  /** Declared values of enum params, so `-X {method}` with `method: ["GET", "POST"]` is also checked. */
  enumValues?: Record<string, readonly string[]>;
  /** Working directory the script runs in (absolute); argv paths are resolved from it. Default: `root`. */
  cwd?: string;
}

/**
 * Scans the command line (one rendering per declared enum value) and every repo file the command or an
 * argv literal points to. Returns no findings when nothing looks like a write; never "approves".
 */
export async function guardScript({ command, argv, enumValues = {}, cwd }: GuardInput, root: string): Promise<GuardFinding[]> {
  const line = [command, ...argv].join(" ");
  const renderings = [line];
  for (const [name, values] of Object.entries(enumValues)) {
    for (const value of values) renderings.push(line.replaceAll(`{${name}}`, value));
  }
  const findings: GuardFinding[] = renderings.flatMap((text) => findWriteOperations(text).map((f) => ({ ...f, source: "command line" })));

  const files = new Set<string>();
  const commandFile = await repoFile(command, root, root);
  if (commandFile) files.add(commandFile);
  for (const token of argv) {
    if (token.match(PLACEHOLDER)) continue;
    const file = await repoFile(token, cwd ?? root, root);
    if (file) files.add(file);
  }
  for (const file of files) {
    const text = (await readFile(file)).subarray(0, MAX_SCANNED_BYTES).toString("utf8");
    const source = relative(root, file).split(sep).join("/");
    findings.push(...findWriteOperations(text, { shell: isShellFile(file, text) }).map((f) => ({ ...f, source })));
  }
  // One finding per family and source keeps the warning readable.
  const seen = new Set<string>();
  return findings.filter((f) => !seen.has(`${f.family}|${f.source}`) && seen.add(`${f.family}|${f.source}`));
}
