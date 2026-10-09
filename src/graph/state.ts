import { Annotation } from "@langchain/langgraph";
import type { Llm } from "../llm.js";
import type { PendingStore } from "../pending/store.js";
import type { Retriever } from "../rag/retriever.js";
import type { ToolProvider } from "../tools/types.js";

/**
 * Routes the LLM router may choose. `sensitive` = a real action that needs human approval;
 * `refuse` = secrets, the system prompt or attempts to override the instructions (refused directly).
 */
export const ROUTES = ["question", "task", "sensitive", "refuse", "out_of_scope"] as const;
/** Every graph route: the LLM routes plus deterministic ones (`clarify`: an unresolvable follow-up reference). */
export const GRAPH_ROUTES = [...ROUTES, "clarify"] as const;
export type Route = (typeof GRAPH_ROUTES)[number];

export type Outcome = "answered" | "unknown" | "approved" | "rejected" | "out_of_scope" | "clarify" | "refused";

export interface Source {
  source: string;
  heading: string;
  score: number;
}

export interface ReviewRequest {
  question: string;
  draft: string;
}

export interface ReviewDecision {
  approved: boolean;
  note?: string;
}

/** One tool result kept in state, in conversation memory and (summarized) in the daily log. */
export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  readOnly: boolean;
  /** Parsed JSON payload when possible, otherwise the raw text. */
  result: unknown;
  /** True when the data was reused from an earlier turn instead of calling the tool again. */
  fromMemory?: boolean;
}

/** A completed turn of a requester's conversation (short-term memory). */
export interface ConversationTurn {
  question: string;
  route?: Route;
  answer: string;
  toolResults: ToolCallRecord[];
}

/** An item from an earlier tool result that a follow-up ("el primero", "ese ticket") points to. */
export interface ReferencedItem {
  kind: "ticket" | "pipeline" | "item";
  /** Tool that produced the item originally. */
  tool: string;
  /** Short human-readable label, e.g. "pipeline acme-card-elements (job build:elements)". */
  label: string;
  data: Record<string, unknown>;
}

export type ReferenceResolution =
  | { kind: "none" }
  | { kind: "resolved"; item: ReferencedItem }
  | { kind: "ambiguous"; message: string };

export const AgentState = Annotation.Root({
  question: Annotation<string>,
  /** Recent turns of the same requester (oldest first); empty for a new conversation. */
  history: Annotation<ConversationTurn[]>,
  reference: Annotation<ReferenceResolution>,
  toolCalls: Annotation<ToolCallRecord[]>,
  route: Annotation<Route>,
  topic: Annotation<string>,
  routeReason: Annotation<string>,
  answer: Annotation<string>,
  sources: Annotation<Source[]>,
  draft: Annotation<string>,
  outcome: Annotation<Outcome>,
});

export type State = typeof AgentState.State;
export type Update = typeof AgentState.Update;

export interface GraphDeps {
  llm: Llm;
  retriever: Retriever;
  tools: ToolProvider;
  pending: PendingStore;
  /** Hosts replies may link to (output guard); defaults to `DEFAULT_ALLOWED_LINK_HOSTS`. */
  allowedLinkHosts?: readonly string[];
}

export const NO_ANSWER = "No sé / no tengo esa respuesta en la documentación.";
