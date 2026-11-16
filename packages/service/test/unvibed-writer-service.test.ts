/**
 * Graph mode (prototype), over HTTP with a fake agent that calls write_graph over MCP: asking for the graph's state
 * starts a graph-writing session; a draft that fails graph check goes back to the agent with the report; a passing one
 * is served. When the head moves, the graph is hidden while it fails, and the agent updates it, sent back until it keeps
 * the location the reviewer ticked.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent, McpServerConfig, ReviewSnapshot, Session } from "@unvibe/shared";
import { FakeAgentRunner } from "../src/agent/fake.js";
import { createApp } from "../src/server.js";
import { hashRows } from "../../../../../unvibed-graph/src/hunks.ts";
import type { Graph } from "../../../../../unvibed-graph/shared/graph.ts";

const authed = { authorization: "Bearer tok" };
const done: AgentEvent[] = [
  { type: "usage", inputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1 },
  { type: "done", stopReason: "end_turn" },
];

/** A fake agent that, on a graph prompt, runs the test's turn with an MCP client on its session's server. */
class GraphAgent extends FakeAgentRunner {
  servers = new Map<string, McpServerConfig[]>();
  origin = "";
  turn: (text: string, writeGraph: (graph: unknown) => Promise<string>) => Promise<void> = async () => {};
  graphPrompts: string[] = [];
  replies: string[] = [];

  override async start(opts: Parameters<FakeAgentRunner["start"]>[0]): Promise<Session> {
    const session = await super.start(opts);
    this.servers.set(session.id, opts.mcpServers);
    return session;
  }

  override async *prompt(session: Session, text: string): AsyncIterable<AgentEvent> {
    this.prompts.push({ sessionId: session.id, text });
    const url = this.servers.get(session.id)?.[0]?.url;
    if (url && (text.includes("# Write the graph") || text.includes("call write_graph"))) {
      this.graphPrompts.push(text);
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${this.origin}${new URL(url).pathname}`)));
      await this.turn(text, async (graph) => {
        const res = (await client.callTool({ name: "write_graph", arguments: { graph } })) as { content: { text: string }[] };
        const reply = res.content.map((c) => c.text).join("\n");
        this.replies.push(reply);
        return reply;
      });
      await client.close();
    }
    for (const e of done) yield e;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unvibe-graph-writer-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();
const NODE = randomUUID();
const LOCATION = randomUUID();
const renamed = hashRows(["-old", "+NEW"]);
/** The graph of feature's change, with the rename's location at line; with hash, it claims one line added and one removed, and without, write_graph fills them in. */
const graphAt = (line: number, hash = ""): Graph => ({
  schema: "",
  nodes: [{ id: NODE, title: "The rename", text: "Line two now says NEW.", code: [{ id: LOCATION, path: "f.txt", side: "RIGHT", line, hash, added: hash ? 1 : 0, removed: hash ? 1 : 0, text: "Where old became NEW." }] }],
  edges: [],
});

let app: Awaited<ReturnType<typeof createApp>>["app"];
let ctx: Awaited<ReturnType<typeof createApp>>["ctx"];
let agents: GraphAgent;
let reviewId: string;
let head: string;
let base: string;

const routes = () => `/api/reviews/${reviewId}/unvibed`;
const state = async () => (await app.inject({ method: "GET", url: `${routes()}/state`, headers: authed })).json() as { state: string; error?: string };
async function waitFor(what: string, ok: () => Promise<boolean> | boolean) {
  const start = Date.now();
  while (!(await ok())) {
    if (Date.now() - start > 15000) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await state().catch(() => "?"))}, head ${ctx.reviews.getSnapshot(reviewId)?.version?.headSha}, ${agents.graphPrompts.length} graph prompts, replies: ${agents.replies.slice(-1)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

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
  agents = new GraphAgent();
  ({ app, ctx } = await createApp("tok", { agents, autoPipeline: false }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  agents.origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const added = await app.inject({ method: "POST", url: "/api/repos", headers: authed, payload: { path: dir } });
  const repo = (added.json() as { repos: { id: string }[] }).repos.find((r) => r.id !== "demo")!;
  const created = await app.inject({ method: "POST", url: "/api/reviews", headers: authed, payload: { repoId: repo.id, branch: "feature" } });
  reviewId = (created.json() as ReviewSnapshot).review.id;
  await waitFor("the review's version", () => !!ctx.reviews.getSnapshot(reviewId)?.version?.headSha);
}, 30000);

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("graph mode writes its own graph", () => {
  it("with no graph, asking for its state starts a graph-writing session; a failing draft goes back with the report; a passing one is served", async () => {
    let turns = 0;
    agents.turn = async (_text, writeGraph) => {
      turns++;
      // first a hash that's wrong, then blank for write_graph to fill in
      await writeGraph(turns === 1 ? graphAt(2, hashRows(["+other"])) : graphAt(2));
    };
    expect(await state()).toEqual({ state: "writing" });
    expect((await app.inject({ method: "GET", url: `${routes()}/graph.json`, headers: authed })).statusCode).toBe(404);
    await waitFor("the graph", async () => (await state()).state === "ready");

    const [first, second] = agents.graphPrompts;
    expect(first).toContain("docs/writing-graphs.md");
    expect(first).toContain(`git diff ${base} ${head}`);
    expect(first).toContain("Ignore any graph");
    expect(second).toContain("doesn't pass graph check yet");
    expect(second).toContain(`should be: hash ${renamed}, added 1, removed 1`);
    expect(agents.replies[1]).toContain("The graph passes graph check");
    // the writing session has the graph role's tool; its MCP server is its own
    const served = (await app.inject({ method: "GET", url: `${routes()}/graph.json`, headers: authed })).json() as Graph;
    expect(served.nodes[0]!.code[0]).toMatchObject({ id: LOCATION, hash: renamed, added: 1, removed: 1 });
    expect(served.schema).toMatch(/^[0-9a-f]{40}$/);
  });

  it("write_graph is refused to a session without the graph role", async () => {
    const issued = ctx.mcp.issueSession(reviewId, "not-graph", "session");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${agents.origin}${issued.path}`)));
    const res = (await client.callTool({ name: "write_graph", arguments: { graph: graphAt(2) } })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("only available to a graph-writing session");
  });

  it("when the head moves, the failing graph is hidden and updated, and sent back until it keeps the ticked location", async () => {
    await app.inject({ method: "POST", url: `${routes()}/mark`, headers: authed, payload: { hash: renamed, reviewed: true } });
    // two lines on top move the rename from line 2 to line 4
    fs.writeFileSync(path.join(dir, "f.txt"), "x\ny\na\nNEW\nb\n");
    git("commit", "-qam", "two lines on top");
    const moved = git("rev-parse", "HEAD");
    await app.inject({ method: "POST", url: `/api/reviews/${reviewId}/refresh`, headers: authed });
    await waitFor("the new head", () => ctx.reviews.getSnapshot(reviewId)?.version?.headSha === moved);

    const before = agents.graphPrompts.length;
    let turns = 0;
    agents.turn = async (_text, writeGraph) => {
      turns++;
      // first drops the ticked location for a new one, then keeps it, moved to its new line
      const dropped: Graph = { ...graphAt(4), nodes: [{ ...graphAt(4).nodes[0]!, code: [{ ...graphAt(4).nodes[0]!.code[0]!, id: "" }] }] };
      await writeGraph(turns === 1 ? dropped : graphAt(4, renamed));
    };
    expect((await app.inject({ method: "GET", url: `${routes()}/graph.json`, headers: authed })).statusCode).toBe(404);
    expect(await state()).toEqual({ state: "writing" });
    await waitFor("the updated graph", async () => (await state()).state === "ready");

    const [update, sentBack] = agents.graphPrompts.slice(before);
    expect(update).toContain("## The graph so far");
    expect(update).toContain(`location ${LOCATION} (ticked as reviewed), now at f.txt:4-4 (RIGHT)`);
    expect(sentBack).toContain("reviewed state lost");
    const served = (await app.inject({ method: "GET", url: `${routes()}/graph.json`, headers: authed })).json() as Graph;
    expect(served.nodes[0]!.code[0]).toMatchObject({ id: LOCATION, line: 4, hash: renamed });
    expect((await app.inject({ method: "GET", url: `${routes()}/reviewed`, headers: authed })).json()).toEqual([renamed]);
  });

  it("a graph whose head moved but still passes stays shown while it's updated", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    agents.turn = async (_text, writeGraph) => {
      await held;
      await writeGraph(graphAt(4, renamed));
    };
    fs.writeFileSync(path.join(dir, "g.txt"), "new file\n");
    git("add", ".");
    git("commit", "-qm", "another file");
    const next = git("rev-parse", "HEAD");
    await app.inject({ method: "POST", url: `/api/reviews/${reviewId}/refresh`, headers: authed });
    await waitFor("the next head", () => ctx.reviews.getSnapshot(reviewId)?.version?.headSha === next);
    expect(await state()).toEqual({ state: "updating" });
    expect((await app.inject({ method: "GET", url: `${routes()}/graph.json`, headers: authed })).statusCode).toBe(200);
    release();
    await waitFor("the update", async () => (await state()).state === "ready");
  });

  it("an agent that ends its turn without write_graph, after being reminded, fails the job instead of being prompted again and again; retry starts it again", async () => {
    agents.turn = async () => {};
    fs.writeFileSync(path.join(dir, "f.txt"), "x\ny\na\nNEWER\nb\n");
    git("commit", "-qam", "newer");
    const newer = git("rev-parse", "HEAD");
    await app.inject({ method: "POST", url: `/api/reviews/${reviewId}/refresh`, headers: authed });
    await waitFor("the newer head", () => ctx.reviews.getSnapshot(reviewId)?.version?.headSha === newer);

    const before = agents.graphPrompts.length;
    expect(await state()).toEqual({ state: "writing" });
    await waitFor("the job to fail", async () => (await state()).state === "failed");
    expect(agents.graphPrompts.length - before).toBe(2);
    expect((await state()).error).toContain("write_graph");

    agents.turn = async (_text, writeGraph) => {
      await writeGraph(graphAt(4));
    };
    const retried = await app.inject({ method: "POST", url: `${routes()}/retry`, headers: authed });
    expect(retried.json()).toEqual({ state: "writing" });
    await waitFor("the retried graph", async () => (await state()).state === "ready");
    const served = (await app.inject({ method: "GET", url: `${routes()}/graph.json`, headers: authed })).json() as Graph;
    expect(served.nodes[0]!.code[0]).toMatchObject({ line: 4, hash: hashRows(["-old", "+NEWER"]) });
  });
});
