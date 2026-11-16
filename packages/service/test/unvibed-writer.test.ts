/**
 * Graph mode (prototype): what write_graph fills in, what a rewritten graph must keep of the review's reviewed state
 * (ticks, and threads on the graph's text), and graph check's report on a draft.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fillBlanks, graphReport, lostIn, reviewedToKeep, type At } from "../src/routes/unvibed-writer.js";
import { hashRows } from "../../../../../unvibed-graph/src/hunks.ts";
import type { Graph } from "../../../../../unvibed-graph/shared/graph.ts";
import { tempRepo } from "../../../../../unvibed-graph/test/temp-repo.ts";

const lines = (edit: (n: number) => string) => Array.from({ length: 10 }, (_, i) => edit(i + 1)).join("\n") + "\n";
const repo = tempRepo();
repo.write("a.ts", lines((n) => `const a${n} = ${n};`));
repo.git("add", ".");
repo.git("commit", "-qm", "base");
const base = repo.git("rev-parse", "HEAD");
// head 1 changes lines 3 and 8
repo.write("a.ts", lines((n) => `const a${n} = ${n === 3 || n === 8 ? n * 10 : n};`));
repo.git("commit", "-qam", "head 1");
const head1 = repo.git("rev-parse", "HEAD");
// head 2 adds two lines at the top, so line 3's change is now on line 5, and changes line 8's change again
repo.write("a.ts", "// one\n// two\n" + lines((n) => `const a${n} = ${n === 3 ? 30 : n === 8 ? 800 : n};`));
repo.git("commit", "-qam", "head 2");
const head2 = repo.git("rev-parse", "HEAD");

const at1: At = { repo: repo.dir, base, head: head1 };
const at2: At = { repo: repo.dir, base, head: head2 };
const three = hashRows(["-const a3 = 3;", "+const a3 = 30;"]);
const eight = hashRows(["-const a8 = 8;", "+const a8 = 80;"]);
const [N1, N2, L1, L2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const old: Graph = {
  schema: "s",
  nodes: [
    { id: N1, title: "Three", text: "a3 becomes thirty.", code: [{ id: L1, path: "a.ts", side: "RIGHT", line: 3, hash: three, added: 1, removed: 1, text: "Here." }] },
    { id: N2, title: "Eight", text: "a8 becomes eighty.", code: [{ id: L2, path: "a.ts", side: "RIGHT", line: 8, hash: eight, added: 1, removed: 1, text: "There." }] },
  ],
  edges: [],
};
const reviewed = { ticks: new Set([three, eight]), threads: [{ node: N1, quote: "thirty" }] };

describe("what a rewritten graph keeps of the reviewed state", () => {
  it("keeps a ticked location whose code moved, at its new lines, and a thread on its node's text; not one whose code changed", () => {
    const keep = reviewedToKeep(old, reviewed, at2);
    expect(keep).toEqual([
      { node: N1, location: L1, hash: three, now: { path: "a.ts", side: "RIGHT", start_line: 5, line: 5 }, why: "ticked as reviewed" },
      { node: N1, quote: "thirty", why: "a thread is on this text" },
    ]);
  });

  it("a graph that drops the ticked location, or rewrites the text a thread quotes, has lost them", () => {
    const keep = reviewedToKeep(old, reviewed, at2);
    const without: Graph = { ...old, nodes: [{ ...old.nodes[0]!, text: "Changed.", code: [] }] };
    const lost = lostIn(without, keep);
    expect(lost).toHaveLength(2);
    expect(lost[0]).toContain(L1);
    expect(lost[0]).toContain("a.ts:5-5");
    expect(lost[1]).toContain("thirty");
  });

  it("a graph that moves the ticked location to its new lines, same id and hash, keeps it", () => {
    const keep = reviewedToKeep(old, reviewed, at2);
    const moved: Graph = { ...old, nodes: [{ ...old.nodes[0]!, code: [{ ...old.nodes[0]!.code[0]!, start_line: 5, line: 5 }] }] };
    expect(lostIn(moved, keep)).toEqual([]);
  });
});

describe("write_graph's draft", () => {
  it("fills in blank ids, the schema and a blank location's hash and counts, and keeps a hash that was given", () => {
    const draft = {
      schema: "",
      nodes: [
        { id: "", title: "Three", text: "t", code: [{ id: "", path: "a.ts", side: "RIGHT", line: 3, hash: "", added: 0, removed: 0, text: "" }] },
        { id: N2, title: "Eight", text: "t", code: [{ id: L2, path: "a.ts", side: "RIGHT", line: 8, hash: "wrong", added: 1, removed: 1, text: "" }] },
      ],
      edges: [{ id: "", from: N2, to: "" }],
    } as Graph;
    const filled = fillBlanks(draft, at1, "the-schema");
    expect(filled.schema).toBe("the-schema");
    expect(filled.nodes[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(filled.nodes[0]!.code[0]).toMatchObject({ hash: three, added: 1, removed: 1 });
    expect(filled.nodes[0]!.code[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(filled.nodes[1]!.code[0]!.hash).toBe("wrong");
    expect(filled.edges[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(filled.edges[0]!.to).toBe("");
  });

  it("graph check's report: a location that doesn't match fails it with what it should be; lines not shown never do", () => {
    const one: Graph = { ...old, nodes: [old.nodes[0]!] };
    const ok = graphReport(one, at1, []);
    expect(ok.passes).toBe(true);
    expect(ok.text).toContain("ok: all 1 locations match");
    expect(ok.text).toContain("not shown: a.ts");
    const wrong: Graph = { ...one, nodes: [{ ...one.nodes[0]!, code: [{ ...one.nodes[0]!.code[0]!, hash: "wrong" }] }] };
    const failed = graphReport(wrong, at1, []);
    expect(failed.passes).toBe(false);
    expect(failed.text).toContain(`should be: hash ${three}, added 1, removed 1`);
  });

  it("losing reviewed state fails the report", () => {
    const keep = reviewedToKeep(old, reviewed, at2);
    const report = graphReport({ ...old, nodes: [] }, at2, keep);
    expect(report.passes).toBe(false);
    expect(report.text).toContain(L1);
  });
});
