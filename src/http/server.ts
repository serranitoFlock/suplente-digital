import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { PendingEntry } from "../pending/store.js";
import { ConfigValidationError, type RuntimeConfig } from "../runtime-config.js";
import type { AssistantEvents, AssistantService, DecisionResult } from "../service/assistant-service.js";
import { createAuthenticator, type ApiTokens, type Scope } from "./auth.js";
import { doneForScope, failedForScope, jobForScope, needsApprovalForScope, pendingSummaryView } from "./views.js";

/**
 * HTTP API over `AssistantService` (`node:http`, JSON in/out). Two bearer scopes: `client` (a requester-facing
 * adapter such as Teams: submit, own job status, own events) and `admin` (the human backup: everything, plus
 * approve/reject, every job and the pending log and its summary, and the runtime configuration). Errors are
 * `{ error: { code, message } }` without internals.
 */

/** The runtime configuration operations the admin endpoints use (implemented by `RuntimeConfig`). */
export type ConfigAdmin = Pick<RuntimeConfig, "view" | "update" | "setAnthropicApiKey" | "testLlm" | "listModels" | "audit">;

export interface ApiServerOptions {
  service: AssistantService;
  pending: { list(): Promise<PendingEntry[]> };
  tokens: ApiTokens;
  /** Runtime configuration (`/v1/config*`, admin only); without it those endpoints answer 404. */
  config?: ConfigAdmin;
  /** Max request body in bytes (default 16 KB). */
  bodyLimitBytes?: number;
  /** Max body of `PUT /v1/config`, which can carry a script registry (default 256 KB). */
  configBodyLimitBytes?: number;
  /** SSE heartbeat comment interval (default 15 s). */
  heartbeatMs?: number;
  /** One line per request (method, path, status, ms); default stderr. Never receives tokens or query strings. */
  log?: (line: string) => void;
}

const MAX_TEXT = 4000;
const MAX_REQUESTER = 200;
const JOB_STATUSES = ["queued", "running", "needs_approval", "done", "failed"] as const;

const requesterSchema = z.string().trim().min(1).max(MAX_REQUESTER);
const submitSchema = z.object({ text: z.string().trim().min(1).max(MAX_TEXT), requester: requesterSchema.optional() });
const decisionSchema = z.object({ note: z.string().trim().max(MAX_TEXT).optional() });
const requesterQuery = z.object({ requester: requesterSchema });
const optionalRequesterQuery = z.object({ requester: requesterSchema.optional() });
const listQuery = z.object({ status: z.enum(JOB_STATUSES).optional() });
const secretBody = z.object({ value: z.string().trim().min(1).max(1000) });
const llmTestBody = z.object({ overrides: z.unknown().optional() });
const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const notFound = () => new HttpError(404, "not_found", "Not found.");

function validationError(issues: { path: PropertyKey[]; message: string }[]): HttpError {
  return new HttpError(422, "validation_failed", "The request is not valid.", {
    issues: issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error.issues);
  return result.data;
}

interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  scope: Scope;
  query: Record<string, string>;
}

interface Route {
  pattern: RegExp;
  /** Method → minimum scope (`public` needs no token) and handler. */
  methods: Record<string, { scope: Scope | "public"; handle: (ctx: Context, params: string[]) => Promise<void> | void }>;
}

export function createApiServer(options: ApiServerOptions): Server {
  const { service, pending, bodyLimitBytes: defaultBodyLimit = 16 * 1024, heartbeatMs = 15_000, log = (line) => process.stderr.write(`${line}\n`) } = options;
  const { configBodyLimitBytes = 256 * 1024 } = options;
  const authenticate = createAuthenticator(options.tokens);

  const readJson = async (req: IncomingMessage, bodyLimitBytes = defaultBodyLimit): Promise<unknown> => {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (declared > bodyLimitBytes) throw new HttpError(413, "payload_too_large", `The body exceeds ${bodyLimitBytes} bytes.`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > bodyLimitBytes) throw new HttpError(413, "payload_too_large", `The body exceeds ${bodyLimitBytes} bytes.`);
      chunks.push(chunk);
    }
    if (size === 0) return {};
    const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "unsupported_media_type", "Send the body as application/json.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_json", "The body is not valid JSON.");
    }
  };

  /** A client sees only the jobs of the requester it names; anything else is reported as not found. */
  const visibleJob = (ctx: Context, rawId: string) => {
    const requester = ctx.scope === "client" ? parse(requesterQuery, ctx.query).requester : undefined;
    const id = Number(rawId);
    const job = Number.isSafeInteger(id) ? service.status(id) : undefined;
    if (!job || (requester !== undefined && job.requester !== requester)) throw notFound();
    return job;
  };

  const decide = async (ctx: Context, rawId: string, verb: "approve" | "reject") => {
    const { note } = parse(decisionSchema, await readJson(ctx.req));
    const id = Number(rawId);
    const result: DecisionResult = Number.isSafeInteger(id) ? service[verb](id, note) : "not_found";
    if (result === "not_found") throw new HttpError(404, "not_found", `Job #${rawId} does not exist.`);
    if (result === "not_pending") throw new HttpError(409, "not_pending", `Job #${id} is not waiting for approval.`);
    send(ctx.res, 200, { result });
  };

  const events = (ctx: Context) => {
    const { requester } = parse(ctx.scope === "client" ? requesterQuery : optionalRequesterQuery, ctx.query);
    const { res, scope } = ctx;
    const visible = (event: { requester?: string }) => requester === undefined || event.requester === requester;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const emit = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const listeners: { [K in keyof AssistantEvents]: (...args: AssistantEvents[K]) => void } = {
      done: (e) => visible(e) && emit("done", doneForScope(e, scope)),
      needs_approval: (e) => visible(e) && emit("needs_approval", needsApprovalForScope(e, scope)),
      failed: (e) => visible(e) && emit("failed", failedForScope(e, scope)),
    };
    service.on("done", listeners.done);
    service.on("needs_approval", listeners.needs_approval);
    service.on("failed", listeners.failed);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    heartbeat.unref();
    res.on("close", () => {
      clearInterval(heartbeat);
      service.off("done", listeners.done);
      service.off("needs_approval", listeners.needs_approval);
      service.off("failed", listeners.failed);
    });
  };

  /** The runtime configuration, or 404 when this server was built without one. */
  const runtime = (): ConfigAdmin => {
    if (!options.config) throw notFound();
    return options.config;
  };

  /** Runs a configuration change; a rejected change is a 422 with the issue paths (nothing was stored). */
  const configChange = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ConfigValidationError) throw validationError(error.issues.map((issue) => ({ path: issue.path.split("."), message: issue.message })));
      throw error;
    }
  };

  const configRoutes: Route[] = [
    {
      pattern: /^\/v1\/config$/,
      methods: {
        GET: { scope: "admin", handle: ({ res }) => send(res, 200, runtime().view()) },
        PUT: {
          scope: "admin",
          handle: async (ctx) => {
            const config = runtime();
            const patch = await readJson(ctx.req, configBodyLimitBytes);
            send(ctx.res, 200, await configChange(() => config.update(patch)));
          },
        },
      },
    },
    {
      pattern: /^\/v1\/config\/secrets\/anthropic-api-key$/,
      methods: {
        PUT: {
          scope: "admin",
          handle: async (ctx) => {
            const config = runtime();
            const { value } = parse(secretBody, await readJson(ctx.req));
            send(ctx.res, 200, await configChange(() => config.setAnthropicApiKey(value)));
          },
        },
        DELETE: { scope: "admin", handle: async ({ res }) => send(res, 200, await configChange(() => runtime().setAnthropicApiKey(null))) },
      },
    },
    {
      pattern: /^\/v1\/config\/llm\/test$/,
      methods: {
        POST: {
          scope: "admin",
          handle: async (ctx) => {
            const config = runtime();
            const { overrides } = parse(llmTestBody, await readJson(ctx.req));
            send(ctx.res, 200, await configChange(() => config.testLlm(overrides ?? {})));
          },
        },
      },
    },
    { pattern: /^\/v1\/config\/models$/, methods: { GET: { scope: "admin", handle: async ({ res }) => send(res, 200, await runtime().listModels()) } } },
    {
      pattern: /^\/v1\/config\/audit$/,
      methods: { GET: { scope: "admin", handle: (ctx) => send(ctx.res, 200, { entries: runtime().audit(parse(auditQuery, ctx.query).limit) }) } },
    },
  ];

  const routes: Route[] = [
    ...configRoutes,
    { pattern: /^\/health$/, methods: { GET: { scope: "public", handle: ({ res }) => send(res, 200, { status: "ok" }) } } },
    {
      pattern: /^\/v1\/jobs$/,
      methods: {
        POST: {
          scope: "client",
          handle: async (ctx) => {
            const { text, requester } = parse(submitSchema, await readJson(ctx.req));
            if (ctx.scope === "client" && requester === undefined) throw validationError([{ path: ["requester"], message: "Required for the client scope." }]);
            send(ctx.res, 202, service.submit(text, { requester }));
          },
        },
        GET: {
          scope: "admin",
          handle: (ctx) => {
            const { status } = parse(listQuery, ctx.query);
            send(ctx.res, 200, { jobs: service.list().filter((job) => status === undefined || job.status === status) });
          },
        },
      },
    },
    { pattern: /^\/v1\/jobs\/(\d+)$/, methods: { GET: { scope: "client", handle: (ctx, [id]) => send(ctx.res, 200, jobForScope(visibleJob(ctx, id!), ctx.scope)) } } },
    { pattern: /^\/v1\/jobs\/(\d+)\/approve$/, methods: { POST: { scope: "admin", handle: (ctx, [id]) => decide(ctx, id!, "approve") } } },
    { pattern: /^\/v1\/jobs\/(\d+)\/reject$/, methods: { POST: { scope: "admin", handle: (ctx, [id]) => decide(ctx, id!, "reject") } } },
    { pattern: /^\/v1\/pending$/, methods: { GET: { scope: "admin", handle: async ({ res }) => send(res, 200, { entries: await pending.list() }) } } },
    { pattern: /^\/v1\/pending\/summary$/, methods: { GET: { scope: "admin", handle: async ({ res }) => send(res, 200, pendingSummaryView(await pending.list())) } } },
    { pattern: /^\/v1\/events$/, methods: { GET: { scope: "client", handle: events } } },
  ];

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    let params: string[] | undefined;
    const route = routes.find((r) => (params = r.pattern.exec(url.pathname)?.slice(1)) !== undefined);
    if (!route || !params) throw notFound();
    const method = route.methods[req.method ?? ""];
    if (!method) throw new HttpError(405, "method_not_allowed", "Method not allowed.", {}, { allow: Object.keys(route.methods).join(", ") });
    let scope: Scope = "client";
    if (method.scope !== "public") {
      const granted = authenticate(req.headers.authorization);
      if (!granted) throw new HttpError(401, "unauthorized", "Missing or invalid bearer token.", {}, { "www-authenticate": "Bearer" });
      if (method.scope === "admin" && granted !== "admin") throw new HttpError(403, "forbidden", "This token cannot use this endpoint.");
      scope = granted;
    }
    await method.handle({ req, res, url, scope, query: Object.fromEntries(url.searchParams) }, params);
  };

  return createServer((req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    res.on("close", () => log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - startedAt}ms`));
    handle(req, res, url).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        // An unread body (e.g. too large) is not drained: close the connection after answering.
        if (error.status === 413) res.setHeader("connection", "close");
        send(res, error.status, { error: { code: error.code, message: error.message, ...error.extra } }, error.headers);
        return;
      }
      log(`internal error on ${req.method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
      send(res, 500, { error: { code: "internal", message: "Internal error." } });
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}
