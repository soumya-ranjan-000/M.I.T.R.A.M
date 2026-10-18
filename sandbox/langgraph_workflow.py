"""A minimal, runnable LangGraph workflow.

Demonstrates the core ideas of an agentic graph:

    plan ──> draft ──> critique ──┬─(needs work)─> revise ──┐
                                  │                         │
                                  └─────(approved)──> polish ──> END
                                              ▲               │
                                              └───────────────┘

Covered features:
  * a typed state object shared by every node
  * a reducer (``add``) so nodes can append to a list instead of overwriting
  * conditional edges -> branching and a bounded feedback loop
  * a checkpointer -> the run is resumable and inspectable per "thread"

The "model" here is a deterministic stub, so the file runs with no API key:

    pip install langgraph
    python langgraph_workflow.py
"""

from __future__ import annotations

import operator
from typing import Annotated, Literal, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

MAX_REVISIONS = 2


# --------------------------------------------------------------------------- #
# 1. State: the single dict every node reads from and writes to.
# --------------------------------------------------------------------------- #
class BlogState(TypedDict):
    topic: str
    outline: list[str]
    draft: str
    # `Annotated[..., operator.add]` is a reducer: whatever a node returns for
    # this key is concatenated onto the existing value instead of replacing it.
    feedback: Annotated[list[str], operator.add]
    revisions: int
    approved: bool


# --------------------------------------------------------------------------- #
# 2. A fake LLM so the example is deterministic and offline.
#    Swap this for `ChatOpenAI(...).invoke(prompt).content` in real code.
# --------------------------------------------------------------------------- #
def fake_llm(prompt: str) -> str:
    print(f"    [llm] {prompt[:60]}...")
    return f"<text generated for: {prompt[:40]}>"


# --------------------------------------------------------------------------- #
# 3. Nodes: plain functions `state -> partial state update`.
#    Return only the keys you want to change; LangGraph merges them in.
# --------------------------------------------------------------------------- #
def plan(state: BlogState) -> dict:
    print("[plan] building an outline")
    topic = state["topic"]
    return {
        "outline": [f"Why {topic} matters", f"How {topic} works", "Takeaways"],
        "revisions": 0,
        "approved": False,
    }


def draft(state: BlogState) -> dict:
    print("[draft] writing first version")
    sections = "; ".join(state["outline"])
    return {"draft": fake_llm(f"Write a post about {state['topic']} covering {sections}")}


def critique(state: BlogState) -> dict:
    """Judge the draft. The stub approves once it has been revised enough."""
    print("[critique] reviewing the draft")
    if state["revisions"] >= MAX_REVISIONS:
        return {"approved": True, "feedback": ["Looks good, ship it."]}
    return {
        "approved": False,
        "feedback": [f"Revision {state['revisions'] + 1}: add a concrete example."],
    }


def revise(state: BlogState) -> dict:
    print("[revise] applying the latest feedback")
    latest = state["feedback"][-1]
    return {
        "draft": fake_llm(f"Rewrite this draft. Feedback: {latest}"),
        "revisions": state["revisions"] + 1,
    }


def polish(state: BlogState) -> dict:
    print("[polish] final pass")
    return {"draft": state["draft"] + "\n\n-- reviewed and formatted --"}


# --------------------------------------------------------------------------- #
# 4. Router: a conditional edge decides where control flows next.
#    It returns a label, and the mapping below turns that label into a node.
# --------------------------------------------------------------------------- #
def route_after_critique(state: BlogState) -> Literal["approved", "needs_work"]:
    if state["approved"] or state["revisions"] >= MAX_REVISIONS:
        return "approved"
    return "needs_work"


# --------------------------------------------------------------------------- #
# 5. Wire the graph together and compile it.
# --------------------------------------------------------------------------- #
def build_graph():
    builder = StateGraph(BlogState)

    builder.add_node("plan", plan)
    builder.add_node("draft", draft)
    builder.add_node("critique", critique)
    builder.add_node("revise", revise)
    builder.add_node("polish", polish)

    builder.add_edge(START, "plan")
    builder.add_edge("plan", "draft")
    builder.add_edge("draft", "critique")
    builder.add_conditional_edges(
        "critique",
        route_after_critique,
        {"needs_work": "revise", "approved": "polish"},
    )
    builder.add_edge("revise", "critique")  # the loop back
    builder.add_edge("polish", END)

    # The checkpointer persists state after every step, keyed by thread_id.
    return builder.compile(checkpointer=MemorySaver())


def main() -> None:
    graph = build_graph()

    # Everything sharing a thread_id shares memory, so you can resume a run.
    config = {"configurable": {"thread_id": "post-001"}}

    print("=== streaming each node as it finishes ===")
    for step in graph.stream({"topic": "agentic workflows"}, config):
        for node, update in step.items():
            print(f"  -> {node} updated {sorted(update)}")

    final = graph.get_state(config).values

    print("\n=== final state ===")
    print(f"topic     : {final['topic']}")
    print(f"outline   : {final['outline']}")
    print(f"revisions : {final['revisions']}")
    print("feedback  :")
    for item in final["feedback"]:
        print(f"  - {item}")
    print(f"\ndraft:\n{final['draft']}")

    # Checkpoints make the whole run replayable / debuggable.
    history = list(graph.get_state_history(config))
    print(f"\n{len(history)} checkpoints recorded for thread 'post-001'")


if __name__ == "__main__":
    main()
