import { Annotation } from "@langchain/langgraph";
import type { Llm } from "../llm.js";
import type { PendingStore } from "../pending/store.js";
import type { Retriever } from "../rag/retriever.js";
import type { ToolProvider } from "../tools/types.js";

export const ROUTES = ["question", "task", "sensitive", "out_of_scope"] as const;
export type Route = (typeof ROUTES)[number];

export type Outcome = "answered" | "unknown" | "approved" | "rejected" | "out_of_scope";

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

export const AgentState = Annotation.Root({
  question: Annotation<string>,
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
