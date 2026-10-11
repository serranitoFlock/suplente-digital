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
