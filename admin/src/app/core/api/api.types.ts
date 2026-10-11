/** Mirrors of the admin-scope API views (`src/http/views.ts` and `src/service/assistant-service.ts`). */

export type JobStatus = 'queued' | 'running' | 'needs_approval' | 'done' | 'failed';

export type JobRoute =
  | 'question'
  | 'task'
  | 'sensitive'
  | 'refuse'
  | 'out_of_scope'
  | 'clarify'
  | 'capabilities';

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
