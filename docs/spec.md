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

- Spanish-language chat (CLI for the MVP).
- Knowledge base: markdown files in `knowledge/`, chunked by heading and embedded locally.
- Read-only tools: ticket lookup, ticket search, failed pipelines.
- Human-in-the-loop approval for sensitive requests.
- Pending log + welcome-back summary.

## Non-scope

- Executing any write action (merge, deploy, delete, approve, permission changes).
- Handling secrets or credentials.
- Web/Teams UI, real MCP wiring and authentication (planned, see `odd/tasks/suplente-digital.md`).

## Routes

| Route | Trigger | Behavior |
|-------|---------|----------|
| `question` | Knowledge/procedure question | Retrieve top-k chunks; answer only from context with `[n]` citations; otherwise reply "No sé" and log pending |
| `task` | Live operational info (tickets, pipelines) | Model picks one read-only tool (validated with zod); result summarized |
| `sensitive` | Irreversible, permissioned or secret-related | Draft reply → `interrupt` → human approves/rejects → logged |
| `out_of_scope` | Unrelated to the team | Polite decline, no further model calls |

The router is an LLM classifier with a deterministic safety net (`detectSensitive`): matching requests are forced to `sensitive` even if the model disagrees. Unparseable router output falls back to `question`, which can only answer from docs.

## Tools & permissions

| Tool | Args | Access |
|------|------|--------|
| `get_ticket` | `key` (`ABC-123`) | read |
| `search_tickets` | `query` | read |
| `list_failed_pipelines` | `sinceDays` (1–90, default 7) | read |

Providers implement `ToolProvider`. `MockToolProvider` (fixtures) is the default; `McpToolProvider` connects to an MCP server over stdio only when `MCP_SERVER_COMMAND` is set, and only calls the mapped read-only tool names.

## Safety rules

1. Never execute irreversible actions; the bot has no write tools.
2. Never reveal secrets; secret requests are always escalated.
3. Answer only from retrieved context; cite sources; say "No sé" otherwise.
4. Every unresolved or escalated request is logged locally (`data/pending.json`, gitignored).
5. No real client data in the repo: knowledge and fixtures are fictional (Acme, `cdn.example.com`).

## Acceptance criteria

- [x] Questions with relevant docs are answered with a `Fuentes:` list (file › heading).
- [x] Questions without sufficient context return "No sé" and create a pending entry.
- [x] Task requests call exactly one validated read-only tool.
- [x] Sensitive requests pause the graph until a human decision and record it.
- [x] `npm run summary` groups pending entries by topic and suggests docs to write.
- [x] Everything runs without credentials except the LLM calls (mock tools, local embeddings).
- [x] Unit tests cover chunking, ranking, router parsing, safety net, pending store/summary, tools and graph flows with a fake LLM.

## Eval plan

`evals/questions.json` holds 14 cases (answerable, must-say-"no sé", tasks, sensitive, out-of-scope). `npm run eval` runs them through the real graph (configured LLM — local OpenAI-compatible model by default or Claude — + local embeddings + mock tools, isolated pending log; escalations auto-rejected) and reports:

- **Route accuracy** — router decision vs expected route.
- **Fact hit rate** — expected key facts found in the reply body (sources excluded).
- **Correct "no sé"** — unknown questions declined, answerable questions answered.

Targets for the MVP: route accuracy ≥ 90%, correct "no sé" ≥ 90%, fact hit rate ≥ 70%. Tune `retrieval.minScore` in `src/config.ts` against these numbers.
