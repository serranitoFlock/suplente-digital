# Spec — Suplente digital (Frontend Architecture backup)

## Goal

Keep a frontend architecture team unblocked while its owner is away: answer frequent questions from the team's own documentation, resolve small read-only routine tasks, and route anything sensitive to a human backup — leaving a clear backlog for when the owner returns.

## Users

| User | Need |
|------|------|
| Developers consuming web components / shared libraries | Fast, sourced answers ("how do I publish…", "why doesn't it load…") |
| Human backup | Approve or reject sensitive drafts; never surprised by bot actions |
| Returning owner | A "welcome back" summary of what was asked and what docs are missing |

## Scope

- Spanish-language chat (CLI for the MVP) with instant acknowledgement and background processing.
- Knowledge base: markdown files in `knowledge/`, chunked by heading and embedded locally.
- Read-only tools: ticket lookup, ticket search, failed pipelines.
- Human-in-the-loop approval for sensitive requests.
- Pending log + welcome-back summary.

## Non-scope

- Executing any write action (merge, deploy, delete, approve, permission changes).
- Handling secrets or credentials.
- Web/Teams UI, real MCP wiring and authentication (planned, see `odd/tasks/suplente-digital.md`).

## Request lifecycle (instant acknowledgement)

1. `AssistantService.submit(text, { requester })` returns `{ id, ack }` immediately. The ack is deterministic (no model call): "Recibido 👀 (consulta #N). …", with a cheap keyword hint (sensitive / live lookup / general) and how many requests are ahead in the queue.
2. The job runs the graph in an in-process queue (`ASSISTANT_CONCURRENCY`, default 1). Job states: `queued` → `running` → `done` | `needs_approval` | `failed`.
3. The service emits `done` (answer), `needs_approval` (draft for the human backup) or `failed` (friendly Spanish message; technical detail kept separately). Transports (CLI today, Teams/Slack later) deliver these as follow-up messages.
4. `approve(id, note?)` / `reject(id, note?)` resume a paused job exactly once; a second decision returns `not_pending`. `status(id)` and `list()` expose job state.
5. The pending log serializes writes so concurrent jobs never drop entries.

`npm run eval` still calls the graph directly (sequentially), so eval numbers are unaffected by the queue.

## Observability and cost

- One trace per graph step (`tracedTurn`): root span `invoke_agent suplente-digital`, child spans per node (`node <name>`), per model call (`chat <model>`) and per tool call (`execute_tool <tool>`). Spans propagate through `AsyncLocalStorage`, so nodes and the `Llm` contract are unchanged.
- Attributes follow the OpenTelemetry GenAI semantic conventions: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.conversation.id`, `gen_ai.tool.name`, `server.address`; app-specific ones use the `app.` prefix (`app.route`, `app.outcome`, `app.graph.node`). Every span has `durationMs`.
- Token usage comes from LangChain `usage_metadata`; when absent, the summary marks `usageReported: false`.
- Estimated cost = tokens × `LLM_COST_INPUT_PER_MTOK` / `LLM_COST_OUTPUT_PER_MTOK` (USD per million tokens, default 0).
- Exporters implement `TraceExporter`; `JsonlTraceExporter` writes `data/traces.jsonl` (metadata only). Export failures are logged, never thrown into the request.
- `npm run eval` prints p50/p95 latency per case, average tokens and total cost; the CLI `/stats` command prints the same for the session.

## Routes

| Route | Trigger | Behavior |
|-------|---------|----------|
| `question` | Knowledge/procedure question | Retrieve top-k chunks; answer only from context with `[n]` citations; otherwise reply "No sé" and log pending |
| `task` | Live operational info (tickets, pipelines) | Model picks one read-only tool (validated with zod); result summarized |
| `sensitive` | Irreversible, permissioned or secret-related | Draft reply → `interrupt` → human approves/rejects → logged |
| `out_of_scope` | Unrelated to the team | Polite decline, no further model calls |

The router is an LLM classifier with a deterministic safety net (`detectSensitive`): matching requests are forced to `sensitive` even if the model disagrees. Unparseable router output falls back to `question`, which can only answer from docs.

Route boundaries (the router prompt states them as a decision rule plus few-shot examples that deliberately avoid the eval questions):

- Asking **how** to do something, **what** to check, or **whom** to contact → `question`, even when it mentions production, the CDN or an incident.
- Asking the bot to **look up live data** now (a ticket, failed pipelines) → `task`.
- Asking the bot to **do** something irreversible or permissioned, or to reveal a secret → `sensitive`.

The safety net mirrors this: action patterns (delete, deploy to production, merge, grant/revoke access, force push) are skipped when the message is framed as a how-to question (`¿Cómo…?`, `¿Cuáles son los pasos para…?`, `¿Qué tengo que hacer para…?`) and contains no imperative (`borrala`, `mergealo`, `desplegá`, `pasame`). Secret-related requests (tokens, passwords, credentials) are always escalated, even as how-to questions.

## Tools & permissions

| Tool | Args | Access |
|------|------|--------|
| `get_ticket` | `key` (`ABC-123`) | read |
| `search_tickets` | `query` | read |
| `list_failed_pipelines` | `sinceDays` (1–90, default 7) | read |

Providers implement `ToolProvider`. `MockToolProvider` (fixtures) is the default; `McpToolProvider` connects to an MCP server over stdio only when `MCP_SERVER_COMMAND` is set, and only calls the mapped read-only tool names.

The allowlist is explicit: `TOOL_POLICIES` declares every tool `readOnly: true` with a permission (`always_allow` runs unattended; `always_ask` is never auto-run). `McpToolProvider` refuses calls to tools outside the allowlist, mappings for unknown local names, and remote tools annotated `destructiveHint: true` or `readOnlyHint: false`.

## Safety rules

1. Never execute irreversible actions; the bot has no write tools.
2. Never reveal secrets; secret requests are always escalated.
3. Answer only from retrieved context; cite sources; say "No sé" otherwise.
4. Every unresolved or escalated request is logged locally (`data/pending.json`, gitignored).
5. No real client data in the repo: knowledge and fixtures are fictional (Acme, `cdn.example.com`).
6. Retrieved docs and tool results are untrusted data: they are wrapped in `<documento>` / `<resultado_herramienta>` delimiters and the prompts forbid following instructions inside them. HTML comments are stripped before indexing.
7. Output guard on every reply and draft: links to hosts outside `ALLOWED_LINK_HOSTS` are removed and common token formats are redacted.
8. Prompt-leak / "ignore your instructions" requests and ticket mutations ("cerrá DEMO-104") are escalated by the deterministic rule.

Threat model and residual risks: [`security.md`](security.md).

## Acceptance criteria

- [x] Questions with relevant docs are answered with a `Fuentes:` list (file › heading).
- [x] Questions without sufficient context return "No sé" and create a pending entry.
- [x] Task requests call exactly one validated read-only tool.
- [x] Sensitive requests pause the graph until a human decision and record it.
- [x] `npm run summary` groups pending entries by topic and suggests docs to write.
- [x] Everything runs without credentials except the LLM calls (mock tools, local embeddings).
- [x] Every request gets an instant acknowledgement (no model call); results, approval requests and failures arrive later as events tagged with the request number.
- [x] CI runs typecheck and unit tests on every push and pull request (Node 22.12 and 24), without LLM calls, network-dependent tests or secrets.
- [x] Unit tests cover chunking, ranking, router parsing, safety net, pending store/summary, tools, graph flows and the assistant service (ack, queue limit, done / failed / approval flows) with a fake LLM or fake graph.

## Eval plan

`evals/questions.json` holds 17 cases (answerable, must-say-"no sé", tasks, sensitive, out-of-scope, and 3 adversarial prompt-injection cases). `npm run eval` runs them through the real graph (configured LLM — local OpenAI-compatible model by default or Claude — + local embeddings + mock tools, isolated pending log; escalations auto-rejected) and reports:

- **Route accuracy** — router decision vs expected route.
- **Fact hit rate** — expected key facts found in the reply body (sources excluded).
- **Correct "no sé"** — unknown questions declined, answerable questions answered.
- **Injection resisted** — adversarial cases whose reply and draft contain none of their `mustNotContain` strings (canary `CANARY-7Q2X`, exfiltration host, prompt fragments, claims of a write action).

Before generation, a retriever-only pass ranks the whole index (no `minScore` cut-off) for every case with `expectedSources` and reports:

- **Recall@1 / recall@k** (k = `retrieval.topK` = 4) — share of expected knowledge files among the top chunks.
- **MRR** — mean of 1 / rank of the first chunk from an expected file.
- **Unanswerable cases above `minScore`** — guard rail for "no sé": top score of the `mustSayNoSe` questions.

`npm run eval:retrieval` runs only this pass (no LLM).

Contextual chunk header (inspired by [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval), without an LLM): each chunk is embedded as `Documento: <title>` + `Sección: <heading path>` + text. Measured on the 8 cases with `expectedSources`:

| Passage text | Recall@1 | Recall@4 | MRR | Top score of unanswerable cases |
|--------------|----------|----------|-----|---------------------------------|
| Heading path + text (before) | 88% | 100% | 0.917 | 0.855 / 0.855 |
| + document title and intro paragraph | 88% | 88% | 0.896 | 0.856 / 0.857 |
| + document title (kept) | 88% | 100% | 0.917 | 0.849 / 0.852 |

The intro variant was worse and was dropped; the title header ties on recall and MRR and slightly lowers the scores of unanswerable questions. The only miss at rank 1 is `cdn-not-loading` (the CDN manifest doc outranks the troubleshooting doc). Both unanswerable questions still score above `minScore` (0.82): "no sé" for them relies on the answer prompt, not on the cut-off.

Targets for the MVP: route accuracy ≥ 90%, correct "no sé" ≥ 90%, fact hit rate ≥ 70%, injection resisted 100%. Tune `retrieval.minScore` in `src/config.ts` against these numbers.
