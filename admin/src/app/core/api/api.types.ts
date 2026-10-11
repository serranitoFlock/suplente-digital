/** Mirrors of the admin-scope API views (`src/http/views.ts` and `src/service/assistant-service.ts`). */

export type JobStatus = 'queued' | 'running' | 'needs_approval' | 'done' | 'failed';

export type JobRoute =
  'question' | 'task' | 'sensitive' | 'refuse' | 'out_of_scope' | 'clarify' | 'capabilities';

export interface JobView {
  id: number;
  question: string;
  requester?: string;
  status: JobStatus;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  route?: JobRoute;
  answer?: string;
  /** Model-written reply proposal for an escalation: untrusted text, render as text only. */
  draft?: string;
  error?: string;
}

export interface JobList {
  jobs: JobView[];
}

export interface DecisionResponse {
  result: 'accepted';
}

/** `GET /v1/events` payloads for the admin scope. */
export interface DoneEventData {
  id: number;
  requester?: string;
  question: string;
  route?: JobRoute;
  answer: string;
}

export interface NeedsApprovalEventData {
  id: number;
  requester?: string;
  question: string;
  draft: string;
}

export interface FailedEventData {
  id: number;
  requester?: string;
  question: string;
  message: string;
  error: string;
}

export type AdminEvent =
  | { type: 'done'; data: DoneEventData }
  | { type: 'needs_approval'; data: NeedsApprovalEventData }
  | { type: 'failed'; data: FailedEventData };

/** `GET /v1/pending/summary`: the pending log grouped by topic (`pendingSummaryView` in `src/http/views.ts`). */
export type PendingReason =
  'unknown' | 'unsupported_task' | 'escalated' | 'security_refusal' | 'tool_failure';

export interface PendingItem {
  id: string;
  /** ISO 8601. */
  createdAt: string;
  question: string;
}

export interface UnansweredItem extends PendingItem {
  reason: 'unknown' | 'unsupported_task';
}

export interface EscalationItem extends PendingItem {
  decision?: 'approved' | 'rejected';
  note?: string;
}

export interface TopicSummary {
  topic: string;
  count: number;
  counts: Record<PendingReason, number>;
  /** `knowledge/<topic>.md`, present when the bot had no answer for this topic. */
  suggestedDoc?: string;
  unanswered: UnansweredItem[];
  escalations: EscalationItem[];
  toolFailures: PendingItem[];
  securityRefusals: PendingItem[];
}

export interface PendingSummary {
  total: number;
  topics: TopicSummary[];
}
