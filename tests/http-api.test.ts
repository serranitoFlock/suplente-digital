import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/http/server.js";
import { PendingStore } from "../src/pending/store.js";
import { AssistantService } from "../src/service/assistant-service.js";
import { answered, ControlledRunner, needsReview } from "./helpers/controlled-runner.js";

const CLIENT = "client-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef0";

let dir: string;
let runner: ControlledRunner;
let service: AssistantService;
let pending: PendingStore;
let server: Server;
let base: string;
let logLines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "http-api-"));
  runner = new ControlledRunner();
  service = new AssistantService(runner);
  pending = new PendingStore(join(dir, "pending.json"));
  logLines = [];
  server = createApiServer({ service, pending, tokens: { client: CLIENT, admin: ADMIN }, heartbeatMs: 30, log: (line) => logLines.push(line) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

interface CallOptions {
  token?: string;
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

async function call(path: string, { token, method, body, rawBody, headers = {} }: CallOptions = {}) {
  const init: RequestInit = { method: method ?? (body !== undefined || rawBody !== undefined ? "POST" : "GET"), headers: { ...headers } };
  if (token) (init.headers as Record<string, string>).authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) {
    init.body = rawBody ?? JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] ??= "application/json";
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as any) : undefined };
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Opens the SSE stream and collects its frames (events and comments). */
async function openEvents(query: string, token: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/v1/events${query}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const events: { event: string; data: any }[] = [];
  const comments: string[] = [];
  if (res.ok && res.body) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith(":")) comments.push(frame.slice(1).trim());
            else {
              const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
              const data = /^data: (.*)$/m.exec(frame)?.[1];
              events.push({ event, data: data ? JSON.parse(data) : undefined });
            }
          }
        }
      } catch {
        // aborted
      }
    })();
  }
  return { res, events, comments, close: () => controller.abort() };
}

describe("GET /health", () => {
  it("answers without auth and without build details", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  const routes: { path: string; method: string; body?: unknown; adminOnly: boolean }[] = [
    { path: "/v1/jobs", method: "POST", body: { text: "hola", requester: "ana" }, adminOnly: false },
    { path: "/v1/jobs/1?requester=ana", method: "GET", adminOnly: false },
    { path: "/v1/jobs", method: "GET", adminOnly: true },
    { path: "/v1/jobs/1/approve", method: "POST", body: {}, adminOnly: true },
    { path: "/v1/jobs/1/reject", method: "POST", body: {}, adminOnly: true },
    { path: "/v1/pending", method: "GET", adminOnly: true },
    { path: "/v1/events?requester=ana", method: "GET", adminOnly: false },
  ];

  it.each(routes)("$method $path → 401 without a valid token", async ({ path, method, body }) => {
    for (const token of [undefined, "wrong-token-0123456789abcdef"]) {
      const res = await call(path, { method, body, token });
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("unauthorized");
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it.each(routes.filter((r) => r.adminOnly))("$method $path → 403 with the client token", async ({ path, method, body }) => {
    const res = await call(path, { method, body, token: CLIENT });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("forbidden");
  });

  it("never logs tokens and logs one line per request", async () => {
    await call("/v1/pending", { token: CLIENT });
    await call("/health");
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toMatch(/^GET \/v1\/pending 403 \d+ms$/);
    expect(logLines.join("\n")).not.toContain(CLIENT);
  });
});

describe("jobs", () => {
  it("submits a job and returns the ack at once", async () => {
    const res = await call("/v1/jobs", { body: { text: "¿Cómo publico?", requester: "ana" }, token: CLIENT });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ id: 1, ack: expect.stringContaining("consulta #1") });
    expect(service.status(1)).toMatchObject({ requester: "ana", question: "¿Cómo publico?" });
  });

  it("requires a requester for the client scope but not for admin", async () => {
    const client = await call("/v1/jobs", { body: { text: "hola" }, token: CLIENT });
    expect(client.status).toBe(422);
    expect(client.json.error.issues).toEqual([expect.objectContaining({ path: "requester" })]);
    expect((await call("/v1/jobs", { body: { text: "hola" }, token: ADMIN })).status).toBe(202);
  });

  it("shows a client only its own jobs and hides existence of others", async () => {
    const { json } = await call("/v1/jobs", { body: { text: "q-ana", requester: "ana" }, token: CLIENT });
    await runner.release("q-ana", answered("respuesta"));
    await service.idle();

    const own = await call(`/v1/jobs/${json.id}?requester=ana`, { token: CLIENT });
    expect(own.status).toBe(200);
    expect(own.json).toMatchObject({ id: json.id, status: "done", answer: "respuesta", requester: "ana" });
    expect((await call(`/v1/jobs/${json.id}?requester=bob`, { token: CLIENT })).status).toBe(404);
    expect((await call(`/v1/jobs/${json.id}`, { token: CLIENT })).status).toBe(422);
    expect((await call("/v1/jobs/999?requester=ana", { token: CLIENT })).status).toBe(404);
    expect((await call("/v1/jobs/abc", { token: ADMIN })).status).toBe(404);
  });

  it("hides the draft from the client and shows it to admin", async () => {
    await call("/v1/jobs", { body: { text: "Borrá la rama", requester: "ana" }, token: CLIENT });
    await runner.release("Borrá la rama", needsReview("Borrador secreto"));
    await until(() => service.status(1)?.status === "needs_approval");

    const client = await call("/v1/jobs/1?requester=ana", { token: CLIENT });
    expect(client.json.status).toBe("needs_approval");
    expect(JSON.stringify(client.json)).not.toContain("Borrador secreto");
    const admin = await call("/v1/jobs/1", { token: ADMIN });
    expect(admin.json).toMatchObject({ status: "needs_approval", draft: "Borrador secreto" });
  });

  it("approves and rejects exactly once", async () => {
    for (const q of ["uno", "dos"]) await call("/v1/jobs", { body: { text: q, requester: "ana" }, token: CLIENT });
    await runner.release("uno", needsReview("d1"));
    await runner.release("dos", needsReview("d2"));
    await until(() => service.list().every((j) => j.status === "needs_approval"));

    const first = await call("/v1/jobs/1/approve", { body: { note: "ok" }, token: ADMIN });
    expect(first).toMatchObject({ status: 200, json: { result: "accepted" } });
    const second = await call("/v1/jobs/1/reject", { body: {}, token: ADMIN });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("not_pending");
    // No body at all is allowed for a decision.
    expect((await call("/v1/jobs/2/reject", { method: "POST", token: ADMIN })).status).toBe(200);
    expect((await call("/v1/jobs/42/approve", { body: {}, token: ADMIN })).json.error.code).toBe("not_found");
    await service.idle();
    expect(runner.resumes.map((r) => r.decision)).toEqual([
      { approved: true, note: "ok" },
      { approved: false, note: undefined },
    ]);
  });

  it("lists jobs and the pending log for admin only, with a status filter", async () => {
    await call("/v1/jobs", { body: { text: "a", requester: "ana" }, token: CLIENT });
    await call("/v1/jobs", { body: { text: "b", requester: "bob" }, token: CLIENT });
    await runner.release("a", answered("hecho"));
    await until(() => service.status(1)?.status === "done");
    await pending.append({ question: "¿?", topic: "cdn", reason: "unknown" });

    expect((await call("/v1/jobs", { token: ADMIN })).json.jobs).toHaveLength(2);
    const done = await call("/v1/jobs?status=done", { token: ADMIN });
    expect(done.json.jobs.map((j: { id: number }) => j.id)).toEqual([1]);
    expect((await call("/v1/jobs?status=bogus", { token: ADMIN })).status).toBe(422);
    const log = await call("/v1/pending", { token: ADMIN });
    expect(log.json.entries).toEqual([expect.objectContaining({ question: "¿?", reason: "unknown" })]);
    await runner.release("b", answered("x"));
  });
});

describe("request validation", () => {
  it("rejects bad bodies with 400 / 413 / 415 / 422", async () => {
    const bad = await call("/v1/jobs", { rawBody: "{nope", token: CLIENT });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_json");
    expect((await call("/v1/jobs", { rawBody: "hola", headers: { "content-type": "text/plain" }, token: CLIENT })).status).toBe(415);
    expect((await call("/v1/jobs", { body: { text: "x".repeat(20_000), requester: "ana" }, token: CLIENT })).status).toBe(413);

    const invalid = await call("/v1/jobs", { body: { text: "", requester: "r".repeat(201) }, token: CLIENT });
    expect(invalid.status).toBe(422);
    expect(invalid.json.error.issues.map((i: { path: string }) => i.path).sort()).toEqual(["requester", "text"]);
    expect(JSON.stringify(invalid.json)).not.toMatch(/at .*\.ts/);
    expect((await call("/v1/jobs", { body: { text: "x".repeat(4001), requester: "ana" }, token: CLIENT })).status).toBe(422);
  });

  it("answers 404 for unknown routes and 405 for wrong methods", async () => {
    expect((await call("/v2/nothing", { token: ADMIN })).status).toBe(404);
    const wrong = await call("/v1/pending", { method: "DELETE", token: ADMIN });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
  });
});

describe("GET /v1/events", () => {
  it("streams only the requester's own events to a client, without drafts", async () => {
    const stream = await openEvents("?requester=ana", CLIENT);
    expect(stream.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await call("/v1/jobs", { body: { text: "q-bob", requester: "bob" }, token: CLIENT });
    await call("/v1/jobs", { body: { text: "q-ana", requester: "ana" }, token: CLIENT });
    await call("/v1/jobs", { body: { text: "s-ana", requester: "ana" }, token: CLIENT });
    await runner.release("q-bob", answered("para bob"));
    await runner.release("q-ana", answered("para ana"));
    await runner.release("s-ana", needsReview("Borrador interno"));
    await until(() => stream.events.length >= 2);
    await service.idle();

    expect(stream.events).toEqual([
      { event: "done", data: { id: 2, requester: "ana", question: "q-ana", answer: "para ana" } },
      { event: "needs_approval", data: { id: 3, requester: "ana", question: "s-ana" } },
    ]);
    stream.close();
  });

  it("streams every event to admin, with the draft", async () => {
    const stream = await openEvents("", ADMIN);
    await call("/v1/jobs", { body: { text: "s-ana", requester: "ana" }, token: CLIENT });
    await runner.release("s-ana", needsReview("Borrador interno"));
    await until(() => stream.events.length >= 1);
    expect(stream.events[0]).toEqual({ event: "needs_approval", data: { id: 1, requester: "ana", question: "s-ana", draft: "Borrador interno" } });
    stream.close();
  });

  it("requires a requester for the client scope", async () => {
    const stream = await openEvents("", CLIENT);
    expect(stream.res.status).toBe(422);
  });

  it("sends heartbeats and removes its listeners when the client disconnects", async () => {
    const before = service.listenerCount("done");
    const stream = await openEvents("?requester=ana", CLIENT);
    await until(() => service.listenerCount("done") === before + 1);
    await until(() => stream.comments.includes("ping"));
    stream.close();
    await until(() => ["done", "failed", "needs_approval"].every((e) => service.listenerCount(e as "done") === before));
  });
});
