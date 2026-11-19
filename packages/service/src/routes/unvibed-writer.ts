/**
 * unvibed graph mode (prototype): the agent's graph draft. write_graph fills in what the agent can't work out without
 * a shell (ids, the schema, a location's hash and counts) and answers with graph check's report; a draft is kept only
 * once that report passes, which includes keeping the review's reviewed state: every ticked location, and every
 * thread on the graph's text, whose code is still in the change.
 */
import { randomUUID } from "node:crypto";
import { checkEdgeEnds, checkGraph, checkIds, diffOf, type NotShown } from "unvibed/src/check.ts";
import { git, show } from "unvibed/src/git.ts";
import { getChanges, hashRows, ownRows } from "unvibed/src/hunks.ts";
import type { Graph, Location } from "unvibed/shared/graph.ts";

/** A review's change: its repo, and the merge base and head it compares. */
export type At = { repo: string; base: string; head: string };

type Change = ReturnType<typeof getChanges>[number];

const readAt = (at: At) => (side: Location["side"], path: string) => show(at.repo, side === "LEFT" ? at.base : at.head, path);

/** Each file's changes at at, diffed once. */
function changesAt(at: At) {
  const read = readAt(at);
  const changes = new Map<string, Change[]>();
  return (path: string): Change[] => {
    if (!changes.has(path)) changes.set(path, getChanges(at.repo, read("LEFT", path), read("RIGHT", path)));
    return changes.get(path)!;
  };
}

/** graph with a fresh UUID for every blank id, schema for a blank schema, and its own rows' hash and counts for every location whose hash is blank. */
export function fillBlanks(graph: Graph, at: At, schema: string): Graph {
  const changesOf = changesAt(at);
  const read = readAt(at);
  const idOr = (id: string | undefined) => (id ? id : randomUUID());
  const fillLocation = (loc: Location): Location => {
    const withId = { ...loc, id: idOr(loc.id) };
    if (loc.hash) return withId;
    if (read(loc.side, loc.path) === undefined) return withId;
    return { ...withId, ...diffOf(ownRows(changesOf(loc.path), loc.side, loc.start_line ?? loc.line, loc.line)) };
  };
  return {
    schema: graph.schema ? graph.schema : schema,
    nodes: graph.nodes.map((node) => ({ ...node, id: idOr(node.id), code: node.code.map(fillLocation) })),
    edges: graph.edges.map((edge) => ({ ...edge, id: idOr(edge.id) })),
  };
}

/** What reviewing left on a graph: the hashes ticked as reviewed, and threads on a node's or a location's text. */
export type Reviewed = { ticks: ReadonlySet<string>; threads: { node: string; location?: string; quote: string }[] };

/**
 * Something a rewritten graph must still have: a location, by id and hash, in its node (with the lines it is at now),
 * or a quote a thread holds in a node's or location's text.
 */
export type Keep = {
  node: string;
  location?: string;
  hash?: string;
  now?: { path: string; side: Location["side"]; start_line: number; line: number };
  quote?: string;
  why: string;
};

/** A line's number on side; -1 when the line isn't on that side. */
const lineOn = (side: Location["side"], c: Change) =>
  side === "LEFT" ? (c.type === "normal" ? c.oldLineNumber : c.type === "delete" ? c.lineNumber : -1) : c.type === "normal" ? c.newLineNumber : c.type === "insert" ? c.lineNumber : -1;

/**
 * Where loc's own rows are in changes now: at its own lines, or wherever the same rows, changed the same way, moved to.
 * Undefined when they're gone.
 */
function findNow(loc: Location, changes: Change[]): { start_line: number; line: number } | undefined {
  const start = loc.start_line ?? loc.line;
  const span = loc.line - start;
  const lastLine = Math.max(0, ...changes.map((c) => lineOn(loc.side, c)));
  const matches = (s: number) => s + span <= lastLine && hashRows(ownRows(changes, loc.side, s, s + span)) === loc.hash;
  if (matches(start)) return { start_line: start, line: loc.line };
  if (!loc.added && !loc.removed) return undefined;
  // only windows holding as many added and removed lines as loc are worth hashing
  const added: number[] = [];
  const removed: number[] = [];
  for (const c of changes) {
    const n = lineOn(loc.side, c);
    if (n < 0) continue;
    added[n] = c.type === "insert" ? 1 : 0;
    removed[n] = c.type === "delete" ? 1 : 0;
  }
  for (let s = 1; s + span <= lastLine; s++) {
    let a = 0;
    let r = 0;
    for (let n = s; n <= s + span; n++) {
      a += added[n] ?? 0;
      r += removed[n] ?? 0;
    }
    // a RIGHT location's removed lines sit beside its added ones, and a LEFT one's added lines beside its removed ones
    const counted = loc.side === "RIGHT" ? a === loc.added : r === loc.removed;
    if (counted && matches(s)) return { start_line: s, line: s + span };
  }
  return undefined;
}

/** What a graph rewritten for at must keep of old's reviewed state: ticked or threaded locations whose rows are still in the change, and threads on their nodes' text. */
export function reviewedToKeep(old: Graph, reviewed: Reviewed, at: At): Keep[] {
  const changesOf = changesAt(at);
  const read = readAt(at);
  const keep: Keep[] = [];
  for (const node of old.nodes) {
    let stillThere = node.code.length === 0;
    for (const loc of node.code) {
      if (read(loc.side, loc.path) === undefined) continue;
      const threads = reviewed.threads.filter((t) => t.node === node.id && t.location === loc.id);
      const ticked = reviewed.ticks.has(loc.hash);
      const now = findNow(loc, changesOf(loc.path));
      if (!now) continue;
      stillThere = true;
      if (ticked || threads.length)
        keep.push({ node: node.id, location: loc.id, hash: loc.hash, now: { path: loc.path, side: loc.side, ...now }, why: ticked ? "ticked as reviewed" : "a thread is on its text" });
      for (const t of threads) keep.push({ node: node.id, location: loc.id, quote: t.quote, why: "a thread is on this text" });
    }
    if (!stillThere) continue;
    for (const t of reviewed.threads.filter((t) => t.node === node.id && !t.location)) keep.push({ node: node.id, quote: t.quote, why: "a thread is on this text" });
  }
  return keep;
}

/** Each thing in keep that graph no longer has, said so the agent can put it back. */
export function lostIn(graph: Graph, keep: Keep[]): string[] {
  const lost: string[] = [];
  for (const k of keep) {
    const node = graph.nodes.find((n) => n.id === k.node);
    const loc = k.location ? node?.code.find((l) => l.id === k.location) : undefined;
    if (k.quote !== undefined) {
      const text = k.location ? loc?.text : node?.text;
      if (text?.includes(k.quote)) continue;
      lost.push(`${k.location ? `location ${k.location}` : `node ${k.node}`}: ${k.why}, quoting "${k.quote}"; keep that text in it (node ${k.node}${k.location ? `, location ${k.location}` : ""})`);
      continue;
    }
    if (loc && loc.hash === k.hash) continue;
    const where = k.now ? ` Its code is now at ${k.now.path}:${k.now.start_line}-${k.now.line} (${k.now.side}).` : "";
    lost.push(`location ${k.location}: ${k.why}, and its code is unchanged; keep it, with id ${k.location} and hash ${k.hash}, in node ${k.node}.${where}`);
  }
  return lost;
}

/** How many lines a run of lines not shown has. */
const linesIn = (n: NotShown) => (n.removed ? n.removed.end - n.removed.start + 1 : 0) + (n.added ? n.added.end - n.added.start + 1 : 0);

/** graph check's report on graph at at, as `graph check` prints it, plus the reviewed state it lost; it passes when every location matches, every id is a UUID of its own, every edge joins two nodes and nothing in keep is lost. */
export function graphReport(graph: Graph, at: At, keep: Keep[]): { passes: boolean; text: string } {
  const changedPaths = git(at.repo, "diff", "--name-only", at.base, at.head).trim().split("\n").filter(Boolean);
  const { problems, notShown } = checkGraph(at.repo, graph, readAt(at), changedPaths);
  const out: string[] = [];
  for (const p of problems) {
    out.push(`✗ ${p.node}: ${p.path}:${p.start_line}-${p.line} (${p.side}) ${p.reason}`);
    for (const l of p.actual ?? []) out.push(`    | ${l}`);
    if (p.expected) out.push(`    should be: hash ${p.expected.hash}, added ${p.expected.added}, removed ${p.expected.removed}`);
  }
  const count = graph.nodes.reduce((n, node) => n + node.code.length, 0);
  out.push(problems.length ? `${problems.length} of ${count} locations do not match` : `ok: all ${count} locations match`);
  for (const path of new Set(notShown.map((n) => n.path))) {
    const runs = notShown.filter((n) => n.path === path);
    const listed = runs.map((n) => [n.removed && `-${n.removed.start}-${n.removed.end}`, n.added && `+${n.added.start}-${n.added.end}`].filter(Boolean).join(" "));
    out.push(`not shown: ${path}, ${runs.reduce((sum, n) => sum + linesIn(n), 0)} lines: ${listed.join(", ")}`);
  }
  out.push(notShown.length ? `${notShown.reduce((sum, n) => sum + linesIn(n), 0)} changed lines no location shows (this never fails the check)` : "every changed line is shown");
  const ids = checkIds(graph);
  for (const p of ids) out.push(`✗ ${p.kind} ${p.what}: ${p.id === undefined ? "has no id" : `id ${JSON.stringify(p.id)} ${p.reason === "duplicate" ? "is used more than once" : "isn't a UUID"}`}`);
  const ends = checkEdgeEnds(graph);
  for (const p of ends) out.push(`✗ edge ${p.id}: its ${p.end} node ${JSON.stringify(p.nodeId)} isn't in the graph`);
  const lost = lostIn(graph, keep);
  for (const l of lost) out.push(`✗ reviewed state lost: ${l}`);
  return { passes: !problems.length && !ids.length && !ends.length && !lost.length, text: out.join("\n") };
}
