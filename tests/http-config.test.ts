import { describe, expect, it } from "vitest";
import { createAuthenticator } from "../src/http/auth.js";
import { resolveApiConfig } from "../src/http/config.js";

const CLIENT = "client-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef0";

describe("resolveApiConfig", () => {
  it("uses the local defaults for host and port", () => {
    expect(resolveApiConfig({ ASSISTANT_API_TOKEN: CLIENT, ASSISTANT_ADMIN_TOKEN: ADMIN })).toEqual({
      host: "127.0.0.1",
      port: 8787,
      tokens: { client: CLIENT, admin: ADMIN },
    });
  });

  it("reads host and port overrides", () => {
    const resolved = resolveApiConfig({ ASSISTANT_API_HOST: "0.0.0.0", ASSISTANT_API_PORT: "9000", ASSISTANT_API_TOKEN: CLIENT, ASSISTANT_ADMIN_TOKEN: ADMIN });
    expect(resolved).toMatchObject({ host: "0.0.0.0", port: 9000 });
  });

  it("refuses to start without both tokens", () => {
    expect(() => resolveApiConfig({ ASSISTANT_ADMIN_TOKEN: ADMIN })).toThrow(/ASSISTANT_API_TOKEN is missing/);
    expect(() => resolveApiConfig({ ASSISTANT_API_TOKEN: CLIENT, ASSISTANT_ADMIN_TOKEN: "  " })).toThrow(/ASSISTANT_ADMIN_TOKEN is missing/);
  });

  it("refuses tokens shorter than 24 characters", () => {
    expect(() => resolveApiConfig({ ASSISTANT_API_TOKEN: "short", ASSISTANT_ADMIN_TOKEN: ADMIN })).toThrow(/ASSISTANT_API_TOKEN must be at least 24 characters/);
  });

  it("refuses the same token for both scopes", () => {
    expect(() => resolveApiConfig({ ASSISTANT_API_TOKEN: ADMIN, ASSISTANT_ADMIN_TOKEN: ADMIN })).toThrow(/must be different/);
  });

  it("refuses an invalid port", () => {
    for (const port of ["abc", "0", "70000", "1.5"]) {
      expect(() => resolveApiConfig({ ASSISTANT_API_PORT: port, ASSISTANT_API_TOKEN: CLIENT, ASSISTANT_ADMIN_TOKEN: ADMIN })).toThrow(/ASSISTANT_API_PORT/);
    }
  });

  it("never echoes a token value in its errors", () => {
    expect(() => resolveApiConfig({ ASSISTANT_API_TOKEN: "leaky", ASSISTANT_ADMIN_TOKEN: ADMIN })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("leaky") }),
    );
  });
});

describe("createAuthenticator", () => {
  const authenticate = createAuthenticator({ client: CLIENT, admin: ADMIN });

  it("maps each bearer token to its scope", () => {
    expect(authenticate(`Bearer ${CLIENT}`)).toBe("client");
    expect(authenticate(`Bearer ${ADMIN}`)).toBe("admin");
  });

  it("rejects missing, malformed and unknown credentials", () => {
    for (const header of [undefined, "", CLIENT, `Basic ${CLIENT}`, `Bearer ${CLIENT}x`, `Bearer ${CLIENT.slice(1)}`, "Bearer "]) {
      expect(authenticate(header)).toBeUndefined();
    }
  });
});
