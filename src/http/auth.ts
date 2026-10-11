import { createHash, timingSafeEqual } from "node:crypto";

/** `client`: submit, own job status and events (e.g. the Teams adapter). `admin`: everything, plus decisions and logs. */
export type Scope = "client" | "admin";

export interface ApiTokens {
  client: string;
  admin: string;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Returns a function mapping an `Authorization` header to its scope (undefined when missing or unknown).
 * Tokens are compared as SHA-256 digests with `timingSafeEqual`, so the comparison has a fixed length and time.
 */
export function createAuthenticator(tokens: ApiTokens): (header: string | undefined) => Scope | undefined {
  const admin = digest(tokens.admin);
  const client = digest(tokens.client);
  return (header) => {
    const match = /^Bearer (\S+)$/.exec(header?.trim() ?? "");
    if (!match) return undefined;
    const given = digest(match[1]!);
    // Both comparisons always run, whichever token matches.
    const isAdmin = timingSafeEqual(given, admin);
    const isClient = timingSafeEqual(given, client);
    return isAdmin ? "admin" : isClient ? "client" : undefined;
  };
}
