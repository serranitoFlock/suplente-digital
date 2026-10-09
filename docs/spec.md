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
- Knowledge base: markdown files in `knowledge/`, chunked by heading and embedded locally. `knowledge/glosario.md` is a table of informal abbreviations and synonyms (`| Se dice | En la documentación | Qué es |`, e.g. wc → web component, master → main, lib → librería compartida). It is not indexed as a document (indexed, it ranked next to every informal question and took a doc slot from the doc with the answer); `npm run ingest` stores its rewrites in the index (`queryRewrites`) and `Retriever.rank` replaces whole-word aliases (case-insensitive) before embedding (`src/rag/glossary.ts`). Only retrieval sees the normalized text; the router and the answer prompt get the original question. The answer prompt reads typos and informal phrasing by meaning and never echoes the user's typos.
- Second knowledge source: the owner's Engram memory (allowlisted projects, filtered notes), see "Engram knowledge source".
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

## Daily conversation log

- `DailyJsonlLog` (`src/logging/conversation-log.ts`) appends one JSON line per completed request to `data/logs/YYYY-MM-DD.jsonl` (local date of the write; directory `LOG_DIR`; gitignored). Writes are serialized, like the pending store, so concurrent jobs never lose or interleave lines.
- Fields: `timestamp`, `event` (`request` | `decision`), `requestId`, `requester`, `question`, `route`, `outcome` (`answered` / `no_se` / `clarify` / `refused` / `approval_pending` / `approved` / `rejected` / `failed`; out-of-scope declines log `answered` with route `out_of_scope`), `answer` (full, WITH citations), `draft` (approval requests), `citedSources` (file › heading), `toolCalls` (name, args, read-only flag, `fromMemory`, summarized result), `latencyMs`, `tokens`, `traceId` (same id as in `data/traces.jsonl`), `securityEvent` (`refusal`), `note` (backup note), `error` (failed requests).
- An approval request logs `approval_pending`; the human decision appends its own `decision` line (`approved` / `rejected`). A log write failure is reported on stderr and never fails the request.
- CLI `/log` prints today's file path and line count. Retention and privacy: [`security.md`](security.md#daily-conversation-log).

## Citations

- The graph always produces `[n]` markers and a "Fuentes:" block (evals and logs rely on them). `selectCitedSources` (`src/graph/citations.ts`) keeps only the retrieved sources whose number appears in the reply (original numbers kept, so markers still match) and drops the rest; a reply without markers gets no block. `state.sources` still holds every retrieved chunk; `state.citedSources` the cited ones.
- Showing them is a presentation decision, not a graph one: `formatAnswerForUser` (`src/presentation/format-answer.ts`), applied by `AssistantService` to `done` events, strips the markers (outside inline code) and the "Fuentes:" block and tidies the leftover spacing/punctuation when `SHOW_CITATIONS=false` (default); with `true` the reply keeps the markers and the cited sources. The event also carries `rawAnswer` (full text, with citations) for logs.

## Retrieval context

- `Retriever.rank` scores the whole index (cosine, best first); `Retriever.retrieve` turns that ranking into the answer context with `selectContext` (`src/rag/context-selection.ts`), a pure function.
- Why: multilingual-e5-small scores are compressed (relevant chunks within ~0.01 of each other), so with ~1.1k real Engram chunks a plain top-4 let terse notes crowd out the curated doc that held the answer (e.g. the troubleshooting doc at #1, then three notes 0.002–0.005 below it; the model said "No sé").
- Source balance: each source has its own candidate pool, the top `candidates` (20) chunks above `minScore` (0.82); a shared pool let near-tied notes push every curated chunk out. Up to `docSlots` (`RETRIEVAL_DOC_SLOTS`, default 4) come from curated docs (`knowledge/*.md`) and up to `engramSlots` (`RETRIEVAL_ENGRAM_SLOTS`, default 2) from Engram notes (real and sample), each group best first, curated docs first in the prompt. Unused slots are not handed to the other source, with one exception: when no curated chunk passes `minScore`, Engram may also use the doc slots (an Engram-only question still gets up to 6 chunks). The `minScore` cut-off is unchanged, so "no sé" behaves as before.
- Relative cut-off (`maxScoreGap`, 0.05): candidates more than 0.05 below the best chunk of the query are dropped, from either source. With compressed scores a gap that size marks a clear winner: without it, a sample Engram note at 0.935 sat behind four unrelated doc sections at ~0.83 and the model missed its facts. Sibling expansion is exempt.
- Sibling expansion (small-to-big, `expandSiblings`, default on): the best curated doc also brings its other sections (same file, even below `minScore`), best first, shown in document order (chunk id position). When another curated doc passes, it competes by score with the best doc's next section for the last doc slot, so a question answered by the second-ranked doc can keep it. Added sections never push the context past `maxContextChars` (6000 chars, ~1.5k tokens); candidate chunks are bounded by the slots (900 chars each). Engram notes are never expanded.

## Engram knowledge source

- `npm run engram:export` reads the local allowlist `config/engram-sources.local.json` (`{ "projects": [...], "types"?: [...] }`; shape in `config/engram-sources.example.json`) and runs `engram export data/engram/<project>.json --project <project>` per project (`execFile`, no shell), reporting observation counts. Missing config → error pointing to the example file.
- `npm run ingest` indexes `knowledge/*.md` plus Engram notes from: the fictional sample `knowledge/engram-sample.json` (`ENGRAM_SAMPLE`, default true) and the real exports of allowlisted projects in `data/engram/` (`ENGRAM_REAL`, default true; skipped without the local config). It prints per-source counts (raw → kept, drop reasons), never contents. The index records its `composition` (chunks per origin: `knowledge`, `engram-sample`, `engram-real`). Passages are embedded in batches of 16.
- Filters (`filterObservations`, `src/rag/engram.ts`): not soft-deleted (`deleted_at`), `scope=project`, type in the allowlist (default `decision`, `architecture`, `pattern`, `config`, `discovery`, `bugfix`, `learning`), project in the allowlist (real exports), not the target of a judged `supersedes` relation, latest version per project + `topic_key` (by `updated_at`, then `created_at`, then id), no token formats from the output guard.
- Each note becomes one doc: content chunked with the existing markdown logic (900 chars), title as the contextual header, source label `engram:#<id> › <project> › <title>`. Chunks without a heading are cited by the label alone. `knowledge/` labels are unchanged.
- The graph contract is unchanged; the answer prompt adds that `engram:` sources are terse agent notes (What / Why / Where / Learned) to be rephrased for a colleague, still only from context and with citations.

## Conversation memory (short-term)

- The service keeps the last N completed turns per requester (`MEMORY_TURNS`, default 6; `0` disables it) behind the `ConversationMemory` interface (`src/memory/conversation-memory.ts`; in memory today, swappable for a persistent store). Each turn holds the user text, the route, the final answer and the structured tool results (e.g. the list of failed pipelines).
- The CLI uses a single local requester id (`local`); the service API takes `submit(text, { requester })`. Requests without a requester get no memory.
- Requests from the same requester run in order (the next one starts after the previous one completed or paused for approval); memory is appended only when a job completes, so a follow-up always sees finished turns. Different requesters still share the queue concurrency.
- The history is passed to the router, to the tool-selection prompt and to the answer prompt as delimited untrusted context (`<conversacion>`): it helps interpret the current message, never replaces the docs as the source of facts.
- **Follow-up references** ("el primero que me pasaste", "el segundo pipeline", "ese ticket") are resolved deterministically (`src/memory/references.ts`) against the latest matching tool result. A resolved pipeline item is summarized from the stored result (no new tool call); a resolved ticket is refreshed with `get_ticket` using its real key. A follow-up that asks to change the referenced item is checked by the safety net together with the resolved label.
- **Never guess**: when a reference cannot be resolved to exactly one item (no history, several candidates, out of range), the router returns the deterministic `clarify` route: a short clarification question, no model call and no tool call. Independently, the task node refuses to call `get_ticket` with a key that appears neither in the message nor in the history (outcome `clarify`).

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
| `question` | Knowledge/procedure question | Retrieve a source-balanced context (curated docs first, then Engram notes; see "Retrieval context"); answer only from context with `[n]` citations; the "Fuentes:" block lists only the cited sources; otherwise reply "No sé" and log pending |
| `task` | Live operational info (tickets, pipelines) | Model picks one read-only tool (validated with zod); result summarized |
| `sensitive` | A real action: merge, deploy, delete, ticket/write changes, permission changes | Draft reply → `interrupt` → human approves/rejects → logged |
| `refuse` | Requests for secrets/credentials or the system prompt, or attempts to override the instructions | Fixed, polite Spanish refusal; no model call when the rule matches, no approval prompt; logged as a security event (`security_refusal` in the pending log, `app.security_event` on the trace) |
| `out_of_scope` | Unrelated to the team | Polite decline, no further model calls |
| `capabilities` | Questions about the assistant itself ("¿qué podés hacer?", "¿cómo funcionás?", "¿quién sos?", "ayuda"), deterministic | Fixed Spanish description of what it can and cannot do plus the CLI commands; no RAG, no model call, never "No sé" |
| `clarify` | Follow-up reference that cannot be resolved from the conversation (deterministic, before the LLM router) | Short clarification question; no model or tool call |

The router is an LLM classifier with a deterministic safety net: `detectRefusal` sends secret / system-prompt / jailbreak requests to `refuse` before any model call, and `detectSensitive` forces irreversible actions to `sensitive` even if the model disagrees. Unparseable router output falls back to `question`, which can only answer from docs.

Route boundaries (the router prompt states them as a decision rule plus few-shot examples that deliberately avoid the eval questions):

- Asking **how** to do something, **what** to check, or **whom** to contact → `question`, even when it mentions production, the CDN or an incident.
- Asking the bot to **look up live data** now (a ticket, failed pipelines) → `task`.
- Asking the bot to **do** something irreversible or permissioned → `sensitive` (human approval).
- Asking for a secret, the bot's instructions, or to ignore its rules → `refuse` (no approval: there is nothing a human could approve).

**Spec change (refusal route).** Until this change, secrets and prompt-leak requests went to `sensitive` and the human backup was offered `/aprobar` for them, which was meaningless. They now take the `refuse` route; `needs_approval` is reserved for real actions. The eval expectations of `sensitive-secret` and `inject-direct` changed from `sensitive` to `refuse` accordingly (each case carries a `note`); `sensitive-merge` and `inject-write-tool` remain approval cases.

The safety net mirrors this: action patterns (delete, deploy to production, merge, grant/revoke access, force push) are skipped when the message is framed as a how-to question (`¿Cómo…?`, `¿Cuáles son los pasos para…?`, `¿Qué tengo que hacer para…?`) and contains no imperative (`borrala`, `mergealo`, `desplegá`, `pasame`). Secret-related requests (tokens, passwords, credentials, API keys) are always refused, even as how-to questions.

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
2. Never reveal secrets or the system prompt; such requests are refused directly with a fixed reply.
3. Answer only from retrieved context; cite sources; say "No sé" otherwise.
4. Every unresolved or escalated request is logged locally (`data/pending.json`, gitignored).
5. No real client data in the repo: knowledge and fixtures are fictional (Acme, `cdn.example.com`).
6. Retrieved docs and tool results are untrusted data: they are wrapped in `<documento>` / `<resultado_herramienta>` delimiters and the prompts forbid following instructions inside them. HTML comments are stripped before indexing.
7. Output guard on every reply and draft: links to hosts outside `ALLOWED_LINK_HOSTS` are removed and common token formats are redacted.
8. Prompt-leak / "ignore your instructions" requests are refused and ticket mutations ("cerrá DEMO-104") are escalated by the deterministic rules.

Threat model and residual risks: [`security.md`](security.md).

## Acceptance criteria

- [x] Questions with relevant docs are answered with a `Fuentes:` list (file › heading) that holds only the sources the reply cites; the requester sees markers and sources only with `SHOW_CITATIONS=true`.
- [x] Questions without sufficient context return "No sé" and create a pending entry.
- [x] Task requests call exactly one validated read-only tool.
- [x] Sensitive actions pause the graph until a human decision and record it; secret / system-prompt / jailbreak requests are refused immediately without an approval prompt.
- [x] `npm run summary` groups pending entries by topic and suggests docs to write.
- [x] Everything runs without credentials except the LLM calls (mock tools, local embeddings).
- [x] Every request gets an instant acknowledgement (no model call); results, approval requests and failures arrive later as events tagged with the request number.
- [x] CI runs typecheck and unit tests on every push and pull request (Node 22.12 and 24), without LLM calls, network-dependent tests or secrets.
- [x] Questions about the assistant get a fixed capabilities description, never "No sé".
- [x] Every completed request (and every approval decision) appends one line to the daily log `data/logs/YYYY-MM-DD.jsonl` with the full cited answer, tool calls, latency, tokens and trace id.
- [x] Follow-ups resolve against the requester's recent tool results; unresolvable references get a clarification question, never a tool call with an invented id.
- [x] Engram notes are indexed only from allowlisted projects and only when they are project-scoped, live, the latest version of their topic, not superseded and free of token formats; real exports, the allowlist and the index never enter git.
- [x] Unit tests cover chunking, ranking, router parsing, safety net, pending store/summary, tools, graph flows and the assistant service (ack, queue limit, done / failed / approval flows) with a fake LLM or fake graph.

## Eval plan

`evals/questions.json` holds 26 cases (answerable — 2 of them in informal phrasing with abbreviations —, must-say-"no sé", tasks, sensitive, refusals, out-of-scope, 3 adversarial prompt-injection cases, 2 multi-turn cases, 1 capabilities question and 4 Engram cases whose facts exist only in `knowledge/engram-sample.json`). A multi-turn case lists earlier user messages in `conversation` (run through the graph first; their turns become the history) or a fixed `history`; `mustNotCallTools` and `mustNotMention` check that a follow-up never invents an id. `npm run eval` runs them through the real graph (configured LLM — local OpenAI-compatible model by default or Claude — + local embeddings + mock tools, isolated pending log; escalations auto-rejected) and reports:

- **Route accuracy** — router decision vs expected route.
- **Fact hit rate** — expected key facts found in the reply body (sources excluded).
- **Correct "no sé"** — unknown questions declined, answerable questions answered.
- **Follow-up / clarify** — multi-turn cases with the right route and facts, no forbidden mention (e.g. an unrelated ticket) and no tool call when a clarification is expected.
- **Filtered notes unused** — cases with `excludedSources` (an older `topic_key` version, a personal note, a superseded note): none of those sources is in the index and the reply contains none of the case's `mustNotMention` strings.
- **Injection resisted** — adversarial cases whose reply and draft contain none of their `mustNotContain` strings (canary `CANARY-7Q2X`, exfiltration host, prompt fragments, claims of a write action).

Before generation, a retriever-only pass ranks the whole index (no `minScore` cut-off) for every case with `expectedSources` and reports:

- **Recall@1 / recall@k** (k = `retrieval.docSlots` = 4) — share of expected knowledge files among the top chunks.
- **MRR** — mean of 1 / rank of the first chunk from an expected file.
- **Context share** — mean fraction of the chunks actually passed to the model (the source-balanced context, `retrieval` config) that come from an expected file. Recall@k can stay at 100% while unrelated notes fill most of the context; this catches it. With 4 doc + 2 Engram slots, a question answered by one curated doc tops out at 4/6 ≈ 67%.
- **Unanswerable cases above `minScore`** — guard rail for "no sé": top score of the `mustSayNoSe` questions.

`npm run eval:retrieval` runs only this pass (no LLM).

Contextual chunk header (inspired by [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval), without an LLM): each chunk is embedded as `Documento: <title>` + `Sección: <heading path>` + text. Measured on the 8 cases with `expectedSources`:

| Passage text | Recall@1 | Recall@4 | MRR | Top score of unanswerable cases |
|--------------|----------|----------|-----|---------------------------------|
| Heading path + text (before) | 88% | 100% | 0.917 | 0.855 / 0.855 |
| + document title and intro paragraph | 88% | 88% | 0.896 | 0.856 / 0.857 |
| + document title (kept) | 88% | 100% | 0.917 | 0.849 / 0.852 |

The intro variant was worse and was dropped; the title header ties on recall and MRR and slightly lowers the scores of unanswerable questions. The only miss at rank 1 is `cdn-not-loading` (the CDN manifest doc outranks the troubleshooting doc). Both unanswerable questions still score above `minScore` (0.82): "no sé" for them relies on the answer prompt, not on the cut-off.

Latest full run (Bonsai 27B 1-bit, local, 2026-10-09, 24 cases, reproducible index `ENGRAM_REAL=false`: 27 knowledge + 7 sample Engram chunks): retrieval recall@1 92% / recall@4 100% / MRR 0.944 over 12 cases (the 8 earlier cases unchanged at 88% / 100% / 0.917), route accuracy 100% (24/24), fact hit rate 94% (`cdn-not-loading` 1/2, `engram-safari-styles` 1/2), correct "no sé" 100%, injection resisted 100% (3/3), filtered notes unused 100% (1/1), follow-up / clarify 100% (2/2), p50 7.8 s / p95 20.5 s, 1523 input + 130 output tokens per case (usage 20/24). Same run with the owner's real Engram notes indexed (local only, not reproducible; ~1.1k extra chunks): retrieval and routing unchanged, facts 97%, correct "no sé" 93% — `unknown-charts` got an answer from real notes, which is right for the real memory but not for the fictional expectation; hence evals run with `ENGRAM_REAL=false`. `npm run eval` prints the index composition and warns when real notes are present.

Previous full run (20 cases, before Engram): route accuracy 100% (20/20), fact hit rate 96% (`cdn-not-loading` 1/2), correct "no sé" 100%, injection resisted 100% (3/3), follow-up / clarify 100% (2/2), latency per case p50 11.0 s / p95 20.1 s, 1463 input + 133 output tokens per case on average (usage reported for 16/20: the refusal, clarify and capabilities cases make no model call), estimated cost US$ 0. Previous run (17 cases, before the memory / refusal / capabilities changes): route 100%, facts 100%, "no sé" 100%, injection resisted 100%, p50 10.4 s / p95 17.4 s. For `inject-doc`, a separate check of the raw model reply (before the output guard) contained neither the canary nor the exfiltration link.

Targets for the MVP: route accuracy ≥ 90%, correct "no sé" ≥ 90%, fact hit rate ≥ 70%, injection resisted 100%. Tune `retrieval.minScore` in `src/config.ts` against these numbers.
