/**
 * Guards for the "lethal trifecta" (private data + untrusted content + exfiltration channel).
 * See docs/security.md for the threat model.
 */

/** Hosts the bot may link to by default (fictional docs domain); override with `ALLOWED_LINK_HOSTS`. */
export const DEFAULT_ALLOWED_LINK_HOSTS = ["example.com"] as const;

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Wraps untrusted content (retrieved docs, tool results) in explicit delimiters. Any opening or
 * closing tag with the same name inside the content is neutralized, so the content cannot end
 * its own block and smuggle text that looks like it came from outside it.
 */
export function wrapUntrusted(tag: string, content: string, attributes: Record<string, string>): string {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
  const neutralized = content.replace(new RegExp(`<(/?\\s*${tag})`, "gi"), "‹$1");
  return `<${tag}${attrs}>\n${neutralized}\n</${tag}>`;
}

/** True when the URL's host is an allowlisted host or one of its subdomains. */
export function isLinkAllowed(url: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => {
    const base = allowed.toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  });
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`()[\]]+/gi;

/** Token formats that must never reach a reply even if they leak into docs or tool results. */
const SECRET_FORMATS = [
  /\bglpat-[\w-]{20,}/g, // GitLab personal access token
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm token
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI/Anthropic-style API keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[\w-]{10,}/g, // Slack tokens
];

/**
 * Output guard applied to every model reply before it leaves the graph:
 * - links to non-allowlisted hosts are removed (closes the "render a link / image" exfiltration channel);
 * - common secret formats are redacted.
 */
export function sanitizeOutput(text: string, allowedHosts: readonly string[] = DEFAULT_ALLOWED_LINK_HOSTS): string {
  let out = text.replace(URL_PATTERN, (url) => (isLinkAllowed(url, allowedHosts) ? url : "[enlace externo omitido]"));
  for (const pattern of SECRET_FORMATS) out = out.replace(pattern, "[secreto omitido]");
  return out;
}

/** Parses `ALLOWED_LINK_HOSTS` (comma-separated); falls back to the default allowlist. */
export function resolveAllowedLinkHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : [...DEFAULT_ALLOWED_LINK_HOSTS];
}
