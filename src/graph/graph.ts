import { Command, END, MemorySaver, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { makeAnswerNode } from "./answer.js";
import { makeDraftNode, makeHumanReviewNode, outOfScopeNode } from "./escalate.js";
import { makeRouterNode } from "./router.js";
import { AgentState, type GraphDeps, type ReviewDecision, type ReviewRequest, type State } from "./state.js";
import { makeTaskNode } from "./task.js";

export function buildGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver = new MemorySaver()) {
  return new StateGraph(AgentState)
    .addNode("router", makeRouterNode(deps.llm))
    .addNode("rag_answer", makeAnswerNode(deps))
    .addNode("run_task", makeTaskNode(deps))
    .addNode("draft_escalation", makeDraftNode(deps))
    .addNode("human_review", makeHumanReviewNode(deps))
    .addNode("out_of_scope", outOfScopeNode)
    .addEdge(START, "router")
    .addConditionalEdges("router", (state) => state.route, {
      question: "rag_answer",
      task: "run_task",
      sensitive: "draft_escalation",
      out_of_scope: "out_of_scope",
    })
    .addEdge("draft_escalation", "human_review")
    .addEdge("rag_answer", END)
    .addEdge("run_task", END)
    .addEdge("human_review", END)
    .addEdge("out_of_scope", END)
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

export async function askAgent(graph: AgentGraph, question: string, threadId: string): Promise<AgentTurn> {
  await graph.invoke({ question }, threadConfig(threadId));
  return readTurn(graph, threadId);
}

export async function resumeAgent(graph: AgentGraph, decision: ReviewDecision, threadId: string): Promise<AgentTurn> {
  await graph.invoke(new Command({ resume: decision }), threadConfig(threadId));
  return readTurn(graph, threadId);
}
