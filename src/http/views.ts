import type { PendingEntry, PendingReason } from "../pending/store.js";
import { summarizePending } from "../pending/summary.js";
import type { DoneEvent, FailedEvent, JobView, NeedsApprovalEvent } from "../service/assistant-service.js";
import type { Scope } from "./auth.js";

/**
 * What each scope may see. The client scope (a requester-facing adapter) never gets the escalation draft, the route
 * or technical error details; the admin scope (the human backup) sees everything.
 */

export function jobForScope(job: JobView, scope: Scope) {
  if (scope === "admin") return job;
  const { id, question, requester, status, createdAt, updatedAt, answer } = job;
  return { id, question, requester, status, createdAt, updatedAt, ...(answer !== undefined ? { answer } : {}) };
}

export function doneForScope({ id, requester, question, route, answer }: DoneEvent, scope: Scope) {
  return scope === "admin" ? { id, requester, question, route, answer } : { id, requester, question, answer };
}

export function needsApprovalForScope({ id, requester, question, draft }: NeedsApprovalEvent, scope: Scope) {
  return scope === "admin" ? { id, requester, question, draft } : { id, requester, question };
}

export function failedForScope({ id, requester, question, message, error }: FailedEvent, scope: Scope) {
  return scope === "admin" ? { id, requester, question, message, error } : { id, requester, question, message };
}

const pick = (entries: PendingEntry[], ...reasons: PendingReason[]) => entries.filter((e) => reasons.includes(e.reason));
const item = ({ id, createdAt, question }: PendingEntry) => ({ id, createdAt, question });

/**
 * `GET /v1/pending/summary`: the pending log grouped by topic (order and suggested doc from `summarizePending`) as
 * plain data for the panel. Escalation drafts are left out: the admin reads them in the job itself.
 */
export function pendingSummaryView(entries: PendingEntry[]) {
  const topics = summarizePending(entries).map(({ topic, count, suggestedDoc }) => {
    const items = entries.filter((e) => e.topic === topic);
    const counts = Object.fromEntries(
      (["unknown", "unsupported_task", "escalated", "security_refusal", "tool_failure"] as const).map((r) => [r, pick(items, r).length]),
    ) as Record<PendingReason, number>;
    return {
      topic,
      count,
      counts,
      ...(suggestedDoc ? { suggestedDoc: `knowledge/${topic}.md` } : {}),
      unanswered: pick(items, "unknown", "unsupported_task").map((e) => ({ ...item(e), reason: e.reason })),
      escalations: pick(items, "escalated").map((e) => ({
        ...item(e),
        ...(e.decision ? { decision: e.decision } : {}),
        ...(e.note ? { note: e.note } : {}),
      })),
      toolFailures: pick(items, "tool_failure").map(item),
      securityRefusals: pick(items, "security_refusal").map(item),
    };
  });
  return { total: entries.length, topics };
}
