/**
 * Graph mode (prototype), over HTTP with a fake agent: a posted unvibed graph becomes cards; Explain on a node's
 * text, a location's text or its code reaches the agent with the quote and an item id that Unvibe's own get_item /
 * get_code resolve to the graph's text and the code's lines. unvibed's /code, /reviewed and /mark answer under the
 * review.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent, ReviewSnapshot } from "@unvibe/shared";
import { FakeAgentRunner } from "../src/agent/fake.js";
import { McpRegistry } from "../src/mcp/registry.js";
import { StoreReviewReader } from "../src/mcp/reviewReader.js";
import { createApp } from "../src/server.js";
import { RealCommandRunner } from "../src/exec/index.js";
import { hashRows } from "unvibed/src/hunks.ts";

const authed = { authorization: "Bearer tok" };
const reply = (text: string): AgentEvent[] => [
  { type: "text", delta: text },
  { type: "usage", inputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1 },
  { type: "done", stopReason: "end_turn" },
];

// main has f.txt with "old" on line 2; feature replaces it with "NEW"
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-graph-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
const NODE = randomUUID();
const LOCATION = randomUUID();
const graph = {
  schema: "test",
  nodes: [
    {
      id: NODE,
      title: "The rename",
      text: "Line two now says NEW instead of old.",
      code: [{ id: LOCATION, path: "f.txt", side: "RIGHT", line: 2, hash: hashRows(["-old", "+NEW"]), added: 1, removed: 1, text: "Where old became NEW." }],
    },
  ],
  edges: [],
};

let app: Awaited<ReturnType<typeof createApp>>["app"];
let ctx: Awaited<ReturnType<typeof createApp>>["ctx"];
let agents: FakeAgentRunner;
let reviewId: string;
let head: string;
let base: string;

beforeAll(async () => {
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "f.txt"), "a\nold\nb\n");
  git("add", ".");
  git("commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  git("switch", "-qc", "feature");
  fs.writeFileSync(path.join(dir, "f.txt"), "a\nNEW\nb\n");
  git("commit", "-qam", "rename");
  head = git("rev-parse", "HEAD");

  process.env.UNVIBE_REPO_ROOTS = "";
  agents = new FakeAgentRunner([
    { match: "reply with exactly", events: reply("ready") },
    { match: "# Ask", events: reply("An answer.") },
  ]);
  ({ app, ctx } = await createApp("tok", { agents, autoPipeline: false }));
  const added = await app.inject({ method: "POST", url: "/api/repos", headers: authed, payload: { path: dir } });
  const repo = (added.json() as { repos: { id: string }[] }).repos.find((r) => r.id !== "demo")!;
  const created = await app.inject({ method: "POST", url: "/api/reviews", headers: authed, payload: { repoId: repo.id, branch: "feature" } });
  reviewId = (created.json() as ReviewSnapshot).review.id;
  const start = Date.now();
  while (!(ctx.reviews.getSnapshot(reviewId)?.version?.headSha) && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 50));
}, 30000);

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const routes = () => `/api/reviews/${reviewId}/unvibed`;

/** Explains a selection and returns the prompt the agent got. */
async function explain(quote: string, anchor: unknown): Promise<string> {
  const before = agents.prompts.length;
  const res = await app.inject({ method: "POST", url: `/api/reviews/${reviewId}/actions`, headers: authed, payload: { kind: "explain", quote, anchor } });
  expect(res.statusCode).toBe(200);
  const start = Date.now();
  // the session's first prompt is its base context; the Ask comes after
  const asked = () => agents.prompts.slice(before).find((p) => p.text.includes("# Ask"));
  while (!asked() && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 50));
  if (!asked()) throw new Error("no Ask prompt; prompts: " + agents.prompts.map((p) => p.text.slice(0, 80)).join(" | "));
  return asked()!.text;
}

/** Unvibe's own MCP tool, as the agent calls it with an id from the prompt. */
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const registry = new McpRegistry({ reader: new StoreReviewReader({ reviews: ctx.reviews, dataDir: ctx.dataDir } as never), commands: new RealCommandRunner() });
  const dispatch = (registry as unknown as { dispatch: (s: unknown, n: string, a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }).dispatch.bind(registry);
  const res = await dispatch({ reviewId }, name, args);
  return (res.isError ? "ERROR " : "") + res.content.map((c) => c.text).join("\n");
}

describe("graph mode over HTTP", () => {
  it("the review is of feature against main", () => {
    expect(ctx.reviews.getSnapshot(reviewId)?.version).toMatchObject({ headSha: head, mergeBaseSha: base });
  });

  it("a posted graph is checked and becomes a page with a card per node", async () => {
    const res = await app.inject({ method: "POST", url: `${routes()}/graph`, headers: authed, payload: graph });
    expect(res.json()).toEqual({ ok: true, cards: 1 });
    const page = ctx.reviews.getSnapshot(reviewId)!.pages.find((p) => p.id === "graph")!;
    expect(page.cards.map((c) => [c.id, c.blocks.map((b) => b.id)])).toEqual([[NODE, [NODE, LOCATION]]]);
    const served = await app.inject({ method: "GET", url: `${routes()}/graph.json`, headers: authed });
    expect(served.json()).toEqual(graph);
  });

  it("a graph whose hash doesn't match the code is refused", async () => {
    const wrong = structuredClone(graph);
    wrong.nodes[0]!.code[0]!.hash = hashRows(["+other"]);
    const res = await app.inject({ method: "POST", url: `${routes()}/graph`, headers: authed, payload: wrong });
    expect(res.statusCode).toBe(400);
  });

  it("Explain on a node's text sends the quote and the node's block id; get_item gives the node's text", async () => {
    const prompt = await explain("now says NEW", { where: "block", blockId: `${NODE}#${NODE}` });
    expect(prompt).toContain("> now says NEW");
    expect(prompt).toContain(`card:${NODE}#${NODE}`);
    expect(await tool("get_item", { id: `card:${NODE}#${NODE}` })).toContain("Line two now says NEW instead of old.");
  });

  it("Explain on a location's text sends its block id; get_item gives the location's text", async () => {
    const prompt = await explain("old became", { where: "block", blockId: `${NODE}#${LOCATION}` });
    expect(prompt).toContain(`card:${NODE}#${LOCATION}`);
    expect(await tool("get_item", { id: `card:${NODE}#${LOCATION}` })).toContain("Where old became NEW.");
  });

  it("Explain on head code sends its lines at the head; get_code gives them", async () => {
    const prompt = await explain("NEW", { where: "code", path: "f.txt", commit: head, line: 2 });
    expect(prompt).toContain(`code:f.txt:2`);
    expect(prompt).toContain(`@${head}`);
    expect(await tool("get_code", { path: "f.txt", lines: "2", sha: head })).toContain("NEW");
    expect(await tool("get_code", { path: "f.txt", lines: "2", sha: base })).toContain("old");
  });

  it("unvibed's /code, /reviewed and /mark answer under the review", async () => {
    const code = await app.inject({ method: "GET", url: `${routes()}/code?path=f.txt&side=RIGHT&start=2&end=2&above=0&below=0`, headers: authed });
    expect(code.statusCode).toBe(200);
    expect((code.json() as { diff: string }).diff).toContain("+NEW");
    const hash = graph.nodes[0]!.code[0]!.hash;
    const mark = await app.inject({ method: "POST", url: `${routes()}/mark`, headers: authed, payload: { hash, reviewed: true } });
    expect(mark.body).toBe("ok");
    const reviewed = await app.inject({ method: "GET", url: `${routes()}/reviewed`, headers: authed });
    expect(reviewed.json()).toEqual([hash]);
    const bad = await app.inject({ method: "POST", url: `${routes()}/mark`, headers: authed, payload: { hash: 5 } });
    expect(bad.statusCode).toBe(400);
  });
});
