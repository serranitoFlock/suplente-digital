# Suplente digital

[![CI](https://github.com/serranitoFlock/suplente-digital/actions/workflows/ci.yml/badge.svg)](https://github.com/serranitoFlock/suplente-digital/actions/workflows/ci.yml)

A digital backup for routine work: a bot trained on a person's (or team's) knowledge that answers frequent questions and covers small read-only tasks while they are on vacation or leave — and escalates everything else to a human.

This instance is configured as the **Frontend Architecture backup** for a fictional company, *Acme*: Angular Elements web components, shared Angular libraries, a shell app, a CDN version manifest and CI pipelines. Users talk to it in Spanish.

> All knowledge docs and tool fixtures are fictional (`Acme`, `cdn.example.com`, `DEMO-101`). No real data, URLs or credentials are included.

## Business impact

**Problem.** Team knowledge often lives in one person. While that person is on vacation or leave, teammates either interrupt whoever covers for them with the same routine questions ("how do I publish a library?", "why doesn't the component load from the CDN?"), dig through docs and tickets on their own, or stay blocked until the person is back. Risky requests (deploy, merge, permissions) have no safe path, and on return the owner has no idea what was asked.

**Who benefits.**

| Who | How |
|-----|-----|
| Developers who consume the person's work | Sourced answers and read-only lookups in seconds to minutes instead of waiting days |
| The human backup | Only gets what really needs a person: sensitive drafts to approve or reject, never routine questions |
| The returning owner | A welcome-back summary (`npm run summary`) grouped by topic, with the questions the docs could not answer → a concrete list of docs to write |

**How it saves time.** Routine questions are answered from the docs with citations, small lookups (ticket status, failed pipelines) are resolved without anyone's credentials, and everything else is escalated or logged instead of lost. Every request gets an instant acknowledgement, so nobody waits on a blank screen.

**Back-of-the-envelope estimate.** Every input below is an **assumption** for illustration, not a measurement; plug in your own numbers.

```text
hours saved per week = Q × R × M / 60
  Q = questions per week that would go to the absent person         (ASSUMPTION: 30)
  R = share the bot resolves without a human (docs or read-only)    (ASSUMPTION: 50%)
  M = minutes saved per resolved question (asker waiting/searching
      + the interrupted teammate's context switch)                   (ASSUMPTION: 15)

30 × 0.5 × 15 / 60 ≈ 3.75 hours per week  →  ≈ 11 hours over a 3-week vacation,
plus Q × R = 15 fewer interruptions per week for the human backup.
```

The model cost side is measured, not assumed: on the eval set a request used on average **1306 input + 129 output tokens** (Bonsai 27B, local, so cost 0). With a hosted model, cost per request ≈ `1306 / 1e6 × input_price + 129 / 1e6 × output_price` (USD per million tokens; set `LLM_COST_INPUT_PER_MTOK` / `LLM_COST_OUTPUT_PER_MTOK` and the bot reports it per request).

**Adoption path.**

1. Swap `knowledge/` for the real person's runbooks and FAQs and run `npm run ingest`; rewrite `evals/questions.json` with real questions (and `expectedSources`) to measure it.
2. Plug a real MCP server (Jira / GitLab) with a **read-only** credential: `MCP_SERVER_COMMAND` + `MCP_TOOL_*`; the allowlist already refuses write tools.
3. Add a Teams (or Slack) adapter on top of `AssistantService` events (see [Instant acknowledgement](#instant-acknowledgement)) and a durable queue/checkpointer.
4. Ship `data/traces.jsonl` to the team's observability stack through a `TraceExporter` (OTel / Langfuse).

**Limitations.**

- The estimate above is illustrative; the real resolution rate depends on how good and current the docs are. The eval set (17 cases) measures answer quality, not adoption.
- It only covers questions the docs answer and three read-only lookups; anything else becomes a pending item, not an answer.
- A local 27B model takes ~10 s per request (p50 on the eval set); that is fine with instant acknowledgement but not for chatty back-and-forth.
- CLI only today: no authentication, no per-user permissions, in-memory queue.

## Rubric map

| Theme | Where it is implemented | Where it is documented / measured |
|-------|-------------------------|-----------------------------------|
| Orquestación | `src/graph/graph.ts` (LangGraph `StateGraph`, router → RAG / tools / human review, `interrupt()` for approvals), `src/service/*` (instant ack + background queue) | [Architecture](#architecture), [`docs/spec.md`](docs/spec.md) → Routes, Request lifecycle; route accuracy in `npm run eval` |
| MCP | `src/tools/mcp-provider.ts` (MCP stdio client, read-only allowlist, refuses destructive tools), `src/tools/types.ts` (`ToolProvider`, `TOOL_POLICIES`) | [`docs/spec.md`](docs/spec.md) → Tools & permissions; `tests/tool-policy.test.ts`. Real server wiring is the next step (T2) |
| RAG | `src/rag/*` (heading-aware chunks, contextual header, local multilingual embeddings), `src/graph/answer.ts` (citations, "No sé") | [`docs/spec.md`](docs/spec.md) → Eval plan (recall@k, MRR, contextual header experiment); fact hit rate and "no sé" in `npm run eval` |
| Observabilidad | `src/observability/*` (one trace per request, OTel GenAI attributes, JSONL exporter), CLI `/stats` | [Observability and cost](#observability-and-cost); latency p50/p95 in `npm run eval` |
| Seguridad | `src/security/guards.ts`, `src/graph/router.ts` (safety net), `TOOL_POLICIES`, human-in-the-loop | [`docs/security.md`](docs/security.md) (lethal trifecta, OWASP LLM01/02/06); injection resisted in `npm run eval` |
| Costo | Local model by default (no API cost), token usage per call, `LLM_COST_*` rates → estimated cost per request | [Observability and cost](#observability-and-cost), [Business impact](#business-impact); tokens and cost in `npm run eval` |
| Impacto de negocio | Pending log + welcome-back summary (`src/pending/*`), escalation instead of silent failure | [Business impact](#business-impact) |
| Quality gate | `tests/*` (fake LLM and embeddings), `.github/workflows/ci.yml` | CI badge above |

## Evaluation results

`npm run eval` with PrismML Bonsai 27B (1-bit, local `llama-server`), 17 cases, run on 2026-10-09:

| Metric | Result |
|--------|--------|
| Retrieval recall@1 / recall@4 / MRR (8 cases with `expectedSources`) | 88% / 100% / 0.917 |
| Route accuracy | 100% (17/17) |
| Fact hit rate | 100% |
| Correct "no sé" | 100% |
| Injection resisted (3 adversarial cases) | 100% (3/3) |
| Latency per case | p50 10.4 s · p95 17.4 s |
| Tokens per case | 1306 in · 129 out (usage reported for 17/17) |
| Estimated cost | US$ 0 (local model) |

Small set, single run, temperature 0.5: treat these as a regression baseline, not a benchmark. An earlier run of the original 14 cases had one flaky "no sé" (`unknown-charts`).

## Architecture

An `AssistantService` acknowledges each request instantly and runs it in a background queue; an orchestrator (LangGraph.js) then routes it to RAG, read-only tools (designed to be backed by MCP servers), or human-in-the-loop review.

```mermaid
flowchart LR
    U([User]) --> SV[AssistantService<br/>instant ack + job queue]
    SV -. "events: done / needs_approval / failed" .-> U
    SV --> R{Router<br/>LLM + safety rules}
    R -- question --> A[RAG answer<br/>local embeddings + citations]
    R -- task --> T[Task node<br/>read-only tools]
    R -- sensitive --> D[Draft reply] --> H{{interrupt:<br/>human backup}}
    R -- out_of_scope --> O[Polite decline]
    A -- "no context → 'No sé'" --> P[(data/pending.json)]
    T -- no suitable tool --> P
    H -- approve / reject --> P
    T --> TP[ToolProvider]
    TP --> M[Mock fixtures]
    TP -.-> MCP[MCP server<br/>Jira / GitLab]
    P --> S[[npm run summary<br/>welcome-back report]]
```

| Piece | Where | Notes |
|-------|-------|-------|
| Service | `src/service/*` | `submit()` → instant deterministic ack; in-process queue (`ASSISTANT_CONCURRENCY`, default 1); typed events; `approve` / `reject` / `status` / `list` |
| Orchestrator | `src/graph/graph.ts` | `StateGraph` + `MemorySaver` checkpointer |
| Router | `src/graph/router.ts` | JSON classification validated with zod + deterministic `detectSensitive` |
| RAG | `src/rag/*`, `src/graph/answer.ts` | Heading-aware chunking with a contextual header (document title + heading path) per chunk, `Xenova/multilingual-e5-small` via `@huggingface/transformers` (no API key), cosine over `data/index.json` |
| Tools | `src/tools/*`, `src/graph/task.ts` | `ToolProvider` interface; mock by default, MCP client when configured |
| Human-in-the-loop | `src/graph/escalate.ts` | LangGraph `interrupt()`; the bot never executes the action |
| Pending log | `src/pending/*` | Append-only JSON + grouped "welcome back" summary |
| Observability | `src/observability/*` | One trace per request, OTel GenAI attribute names, JSONL exporter, token usage and estimated cost, `/stats` |
| Model | `src/llm.ts` | `LLM_PROVIDER=openai-compatible` (default: `ChatOpenAI` against a local Ollama / llama.cpp server) or `anthropic` (`ChatAnthropic`); `<think>` blocks are stripped |

The full spec lives in [`docs/spec.md`](docs/spec.md).

## Quickstart

Requirements: Node.js ≥ 22.12 (required by Vitest 5) and an LLM for chat and evals: a local model behind an OpenAI-compatible server (default, no API key) or an Anthropic API key.

```bash
npm install
cp .env.example .env          # pick the LLM (see "Run with a local model")
npm run ingest                # downloads the embedding model once, builds data/index.json
npm run dev                   # interactive chat
```

If your npm version blocks dependency install scripts, approve `onnxruntime-node` (needed by local embeddings): `npm install-scripts approve onnxruntime-node`.

Other scripts:

| Script | What it does |
|--------|--------------|
| `npm run summary` | Welcome-back report from `data/pending.json` |
| `npm run eval` | Runs `evals/questions.json` through the graph and prints retrieval recall@k / MRR, route accuracy, fact hit rate, correct "no sé", injection resisted, p50/p95 latency, tokens and estimated cost |
| `npm run eval:retrieval` | Retriever-only metrics (recall@1, recall@k, MRR); no LLM needed |
| `npm test` | Unit tests (no network: fake LLM and fake embeddings; the embedding runtime is never loaded) |
| `npm run typecheck` | `tsc --noEmit` |

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`, `npm run typecheck` and `npm test` on Node 22.12 and 24 for every push and pull request. It makes no LLM calls and uses no secrets; dependency install scripts are skipped because tests never load the native embedding runtime (`@huggingface/transformers` is imported lazily).

Example session:

```text
vos> ¿Qué reviso si acme-header no carga desde el CDN?
suplente> Recibido 👀 (consulta #1). Lo estoy revisando y te respondo en cuanto lo tenga.
vos> Mergeá el MR de acme-card a main
suplente> Recibido 👀 (consulta #2). Parece un pedido que necesita aprobación del backup humano: preparo un borrador y te aviso. Hay 1 consulta antes que la tuya.

suplente [#1 · question]> Primero mirá la consola: un 404 sobre bundle.js indica ... [1]
Fuentes:
[1] troubleshooting-componente-no-carga.md › Troubleshooting: el componente no carga > 1. Revisar la consola del navegador

[#2] Pedido sensible: requiere aprobación del backup humano. El bot no ejecuta la acción.
Borrador: ...
→ /aprobar 2 [nota]  o  /rechazar 2 [nota]
```

## Instant acknowledgement

A local model takes ~25 s per answer, so nobody waits on a blank screen. `AssistantService.submit(text, { requester })` returns right away with a deterministic acknowledgement (no model call; keyword hints only), then runs the graph in a background queue:

```text
vos> ¿Cómo publico una versión nueva de @acme/ui-kit?
suplente> Recibido 👀 (consulta #3). Lo estoy revisando y te respondo en cuanto lo tenga.
vos> /estado
#3 [procesando] ¿Cómo publico una versión nueva de @acme/ui-kit?

suplente [#3 · question]> Seguí estos pasos: ... [1]
```

The service emits typed events; transports only decide how to deliver them:

| Event | Payload | Typical delivery |
|-------|---------|------------------|
| `done` | `id`, `requester`, `route`, `answer` | Follow-up reply to the requester |
| `needs_approval` | `id`, `requester`, `draft` | Card to the human backup with approve / reject buttons |
| `failed` | `id`, `requester`, friendly `message`, technical `error` | Friendly reply; `error` goes to logs only |

A Teams (or Slack) adapter would plug in like this:

1. On an incoming message, call `submit(text, { requester })`, reply with `ack` in the same turn, and store the conversation reference keyed by the returned `id`.
2. Subscribe to `done` / `failed` and send the result as a **proactive message** to that stored conversation reference.
3. Send `needs_approval` to the backup's channel as an adaptive card; its buttons call `approve(id, note)` / `reject(id, note)`. The bot still never executes the action.

For production, swap the in-process queue and `MemorySaver` for durable ones (see T3 in the task list) so jobs survive restarts.

CLI commands: `/aprobar <n> [nota]`, `/rechazar <n> [nota]`, `/estado`, `/pendientes`, `/stats`, `/ayuda`, `/salir`. Results print tagged with their number and the prompt is redrawn, so you can keep typing while earlier questions run. On `/salir` or end of input the CLI waits for running jobs; jobs still awaiting approval are reported and nothing is executed.

## Observability and cost

Every request is one trace (root span `invoke_agent suplente-digital`) with a span per graph node (`node router`, `node rag_answer`, …), per model call (`chat <model>`) and per tool call (`execute_tool <tool>`). Attribute names follow the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai):

| Attribute | Example |
|-----------|---------|
| `gen_ai.operation.name` | `invoke_agent`, `chat`, `execute_tool` |
| `gen_ai.provider.name` / `gen_ai.request.model` / `server.address` | `openai-compatible` / `bonsai` / `localhost` |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | from LangChain `usage_metadata` (absent if the server does not report it) |
| `gen_ai.conversation.id`, `app.route`, `app.outcome`, `app.graph.node` | thread id, route, outcome, node name |

- **Where**: `data/traces.jsonl` (gitignored, `TRACES_PATH`), one JSON trace per line with `durationMs` per span and a per-request `summary` (tokens, LLM calls, estimated cost). Metadata only: prompts, questions and replies are never written.
- **Pluggable**: exporters implement `TraceExporter` (`src/observability/tracing.ts`); an OTel or Langfuse exporter can be added without touching the graph. No OTel dependency is required today.
- **Cost**: `LLM_COST_INPUT_PER_MTOK` / `LLM_COST_OUTPUT_PER_MTOK` (USD per million tokens, default `0` for a local model). No vendor prices are hardcoded: set your provider's current rates to get estimates.
- **Where to read it**: `npm run eval` prints p50/p95 latency per case, average tokens and total estimated cost; in the CLI, `/stats` shows the same for the session.

Example (illustrative values, in line with the eval run):

```text
vos> /stats
Consultas procesadas: 3
Latencia: p50 10.4 s · p95 17.4 s
Tokens promedio por consulta: entrada 1306 · salida 129 (con uso reportado: 3/3)
Costo estimado total: US$ 0.0000 (tarifas en 0: modelo local o LLM_COST_* sin configurar)
```

## Run with a local model

The default provider (`LLM_PROVIDER=openai-compatible`) talks to any OpenAI-compatible `/v1` endpoint. `LLM_MODEL` is required; `LLM_API_KEY` is optional (local servers ignore it).

**Ollama** (default `LLM_BASE_URL=http://localhost:11434/v1`):

```bash
ollama pull qwen3:8b
ollama serve                  # if it is not already running
# .env: LLM_MODEL=qwen3:8b
```

**PrismML Bonsai 27B (1-bit)** — recommended temperature 0.5 (the default `LLM_TEMPERATURE`):

- If your Ollama version supports the `Q1_0` quantization type: `ollama pull hf.co/prism-ml/Bonsai-27B-gguf:Q1_0` and set `LLM_MODEL=hf.co/prism-ml/Bonsai-27B-gguf:Q1_0`.
- Otherwise use PrismML's llama.cpp build and run its `llama-server` on port 8080 with the Bonsai GGUF, then set `LLM_BASE_URL=http://localhost:8080/v1` and `LLM_MODEL` to the model name the server reports.

Reasoning models (Qwen3, Bonsai) may emit `<think>…</think>` blocks: they are stripped before routing and answering. `LLM_DISABLE_THINKING=true` (default) also sends `chat_template_kwargs: {enable_thinking: false}`, which llama.cpp honors and other servers ignore. If the server is down, chat and evals fail with a message naming `LLM_BASE_URL` and `ollama serve`.

To use Claude instead: `LLM_PROVIDER=anthropic` plus `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`).

## Adapting it to another person or team

1. **Knowledge**: replace the files in `knowledge/` with that person's docs, runbooks and FAQs (markdown, one topic per heading), then `npm run ingest`.
2. **Prompts**: adjust the persona lines in `src/graph/router.ts` (`ROUTER_PROMPT`) and the other node prompts.
3. **Tools**: implement `ToolProvider` (`src/tools/types.ts`) for your systems, or point `MCP_SERVER_COMMAND` / `MCP_TOOL_*` at an MCP server that exposes equivalent read-only tools.
4. **Safety net**: extend `ACTION_PATTERNS` / `SECRET_PATTERNS` in `src/graph/router.ts` with the irreversible actions of that domain.
5. **Evals**: rewrite `evals/questions.json` with real questions from that team (with `expectedSources` for retrieval metrics) and tune `retrieval.minScore`.

## Safety notes

Full threat model (lethal trifecta, OWASP LLM01/02/06, residual risks): [`docs/security.md`](docs/security.md).

- The bot has **no write tools**; the read-only allowlist (`TOOL_POLICIES`) is enforced by every provider, and the MCP provider refuses unlisted or destructive tools.
- Retrieved docs and tool results are wrapped in delimiters and treated as untrusted data; an output guard strips links to non-allowlisted hosts (`ALLOWED_LINK_HOSTS`) and redacts token formats. `knowledge/faq-registry-npm.md` is a deliberate prompt-injection test fixture.
- The bot never executes actions itself. Sensitive or irreversible requests produce a draft and pause for a human; even approved drafts are executed by people, not by the bot.
- Requests to merge, deploy to production, delete or change permissions are escalated by a deterministic rule, regardless of the model's routing; *how-to* questions about those procedures ("¿Cómo despliego a producción?") are answered from the docs instead. Anything about secrets is always escalated.
- Answers come only from retrieved docs, with citations; otherwise the bot says "No sé" and logs the question.
- `data/` (index and pending log) and `.env` are gitignored.
