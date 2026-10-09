import { Command, END, isGraphInterrupt, MemorySaver, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { withSpan, type Tracer } from "../observability/tracing.js";
import type { ToolProvider } from "../tools/types.js";
import { makeAnswerNode } from "./answer.js";
import { clarifyNode, makeDraftNode, makeHumanReviewNode, makeRefuseNode, outOfScopeNode } from "./escalate.js";
import { makeRouterNode } from "./router.js";
import { AgentState, type ConversationTurn, type GraphDeps, type ReviewDecision, type ReviewRequest, type State } from "./state.js";
import { makeTaskNode } from "./task.js";

/** Wraps a graph node in a span; a LangGraph interrupt (human review pause) is control flow, not an error. */
function traced<S, U>(name: string, node: (state: S) => U | Promise<U>): (state: S) => Promise<U> {
  return (state) =>
    withSpan(`node ${name}`, { "app.graph.node": name }, async () => node(state), { isExpectedError: isGraphInterrupt });
}

/** Adds an OTel GenAI `execute_tool` span around every tool call. */
function tracedTools(tools: ToolProvider): ToolProvider {
  return {
    name: tools.name,
    call: (call) =>
      withSpan(`execute_tool ${call.tool}`, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": call.tool, "app.tool.provider": tools.name }, () =>
        tools.call(call),
      ),
    close: tools.close?.bind(tools),
  };
}

export function buildGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver = new MemorySaver()) {
  const nodeDeps = { ...deps, tools: tracedTools(deps.tools) };
  return new StateGraph(AgentState)
    .addNode("router", traced("router", makeRouterNode(deps.llm)))
    .addNode("rag_answer", traced("rag_answer", makeAnswerNode(nodeDeps)))
    .addNode("run_task", traced("run_task", makeTaskNode(nodeDeps)))
    .addNode("draft_escalation", traced("draft_escalation", makeDraftNode(nodeDeps)))
    .addNode("human_review", traced("human_review", makeHumanReviewNode(nodeDeps)))
    .addNode("out_of_scope", traced("out_of_scope", outOfScopeNode))
    .addNode("clarify", traced("clarify", clarifyNode))
    .addNode("refuse", traced("refuse", makeRefuseNode(nodeDeps)))
    .addEdge(START, "router")
    .addConditionalEdges("router", (state) => state.route, {
      question: "rag_answer",
      task: "run_task",
      sensitive: "draft_escalation",
      out_of_scope: "out_of_scope",
      clarify: "clarify",
      refuse: "refuse",
    })
    .addEdge("draft_escalation", "human_review")
    .addEdge("rag_answer", END)
    .addEdge("run_task", END)
    .addEdge("human_review", END)
    .addEdge("out_of_scope", END)
    .addEdge("clarify", END)
    .addEdge("refuse", END)
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof buildGraph>;

export interface AgentTurn {
  state: State;
  /** Present when the graph paused for human approval. */
  review?: ReviewRequest;
}

const threadConfig = (threadId: string) => ({ configurable: { thread_id: threadId } });

async function readTurn(graph: AgentGraph, threadId: string): Promise<AgentTurn> {
  const snapshot = await graph.getState(threadConfig(threadId));
  const pendingInterrupt = snapshot.tasks.flatMap((task) => task.interrupts)[0];
  return { state: snapshot.values as State, review: pendingInterrupt?.value as ReviewRequest | undefined };
}

/** Runs a new question; `history` holds the requester's recent turns (short-term memory). */
export async function askAgent(graph: AgentGraph, question: string, threadId: string, history: ConversationTurn[] = []): Promise<AgentTurn> {
  await graph.invoke({ question, history }, threadConfig(threadId));
  return readTurn(graph, threadId);
}

/**
 * Runs one graph step (a new question or a resume after review) as one trace, root span
 * `invoke_agent suplente-digital`. Without a tracer it just runs the step.
 */
export async function tracedTurn(
  tracer: Tracer | undefined,
  threadId: string,
  step: "ask" | "resume",
  run: () => Promise<AgentTurn>,
): Promise<AgentTurn> {
  if (!tracer) return run();
  const attributes = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "suplente-digital",
    "gen_ai.conversation.id": threadId,
    "app.step": step,
  };
  const { result } = await tracer.trace("invoke_agent suplente-digital", attributes, async (root) => {
    const turn = await run();
    root.setAttributes({
      "app.route": turn.state.route ?? "unknown",
      "app.outcome": turn.review ? "needs_approval" : (turn.state.outcome ?? "unknown"),
      ...(turn.state.route === "refuse" ? { "app.security_event": "refusal" } : {}),
    });
    return turn;
  });
  return result;
}

export async function resumeAgent(graph: AgentGraph, decision: ReviewDecision, threadId: string): Promise<AgentTurn> {
  await graph.invoke(new Command({ resume: decision }), threadConfig(threadId));
  return readTurn(graph, threadId);
}
