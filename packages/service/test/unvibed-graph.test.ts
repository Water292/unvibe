import { describe, expect, it } from "vitest";
import { graphToPage } from "../src/routes/unvibed.js";

// Graph mode (prototype): an unvibed graph becomes a page of cards, so its text can be anchored and asked about.
const graph = {
  schema: "s",
  nodes: [
    {
      id: "n1",
      title: "First",
      text: "What the first node explains.",
      code: [
        { id: "l1", path: "a.ts", side: "RIGHT" as const, line: 3, hash: "h1", added: 1, removed: 0, text: "What line 3 does." },
        { id: "l2", path: "b.ts", side: "LEFT" as const, start_line: 1, line: 2, hash: "h2", added: 0, removed: 2, text: "What the removed lines did." },
      ],
    },
    { id: "n2", title: "Second", text: "The second node.", code: [] },
  ],
  edges: [],
};

describe("graphToPage", () => {
  it("makes one card per node with the node's id and title, on the graph page", () => {
    const page = graphToPage(graph);
    expect(page).toMatchObject({ id: "graph", kind: "graph", title: "Graph" });
    expect(page.cards.map((c) => [c.id, c.pageId, c.title])).toEqual([
      ["n1", "graph", "First"],
      ["n2", "graph", "Second"],
    ]);
  });

  it("gives each card the node's text as a block with the node's id, then each location's text as a block with its id, unchanged", () => {
    const blocks = graphToPage(graph).cards.map((c) => c.blocks.map((b) => [b.id, b.type === "paragraph" ? b.text.standard : undefined]));
    expect(blocks).toEqual([
      [
        ["n1", "What the first node explains."],
        ["l1", "What line 3 does."],
        ["l2", "What the removed lines did."],
      ],
      [["n2", "The second node."]],
    ]);
  });
});
