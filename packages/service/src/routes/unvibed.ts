/**
 * unvibed graph mode (prototype): stores a review's graph, turns its nodes
 * into guide cards (so `block` anchors resolve and agents get the text), and
 * mounts unvibed's /code, /reviewed and /mark under
 * /api/reviews/:id/unvibed/.
 *
 * A graph is served only while it passes graph check at the review's current
 * version. Asking for the graph's state starts an agent writing one when there
 * is none, or updating it when the head has moved since it was written; the
 * agent's draft replaces the graph once it passes graph check and keeps the
 * reviewed state (see unvibed-writer.ts).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Card, Page } from "@unvibe/shared";
import { z } from "zod/v4";
import type { ServiceContext } from "./context.js";
import type { AppContext } from "../app.js";
import { fillBlanks, graphReport, reviewedToKeep, type At, type Keep, type Reviewed } from "./unvibed-writer.js";
import { cwdForReview } from "./files.js";
import { readRatings, riskPrompt, risksById, unrated, type RiskFile } from "./unvibed-risk.js";
// unvibed's server code, from its checkout beside this one (prototype: no package yet)
import { cutFor, EMPTY_CUT } from "../../../../../../unvibed-graph/src/hunks.ts";
import { isRepoFile, show } from "../../../../../../unvibed-graph/src/git.ts";
import { ReviewStore as MarkStore } from "../../../../../../unvibed-graph/src/review.ts";
import { check, checkEdgeEnds, checkIds } from "../../../../../../unvibed-graph/src/check.ts";
import { CodeQuery, MarkRequest } from "../../../../../../unvibed-graph/shared/graph-and-code.ts";
import type { Graph } from "../../../../../../unvibed-graph/shared/graph.ts";

export const GRAPH_PAGE_ID = "graph";

/** The unvibed checkout beside this one: the first folder up from here with an unvibed-graph/ in it. */
function findUnvibed(): string {
  const env = process.env.UNVIBE_UNVIBED_DIR;
  if (env) return env;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "unvibed-graph", "shared", "graph.ts"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("no unvibed checkout (unvibed-graph/) above the service; set UNVIBE_UNVIBED_DIR");
    dir = up;
  }
  return path.join(dir, "unvibed-graph");
}

/** How long one graph job may run, writing and fixing its draft, before it stops: large, as the agent may need many rounds. */
const GRAPH_BUDGET_MS = Number(process.env.UNVIBE_GRAPH_BUDGET_MS ?? 30 * 60_000);

/** What the agent is told, after the base context: Unvibe's few lines around unvibed's guide to writing a graph. */
function graphPrompt(unvibed: string, at: At, description: string, old?: { graph: Graph; head: string; keep: Keep[] }): string {
  const lines = [
    "# Write the graph",
    "",
    `Write this review's unvibed graph: read \`${unvibed}/docs/writing-graphs.md\` and follow it. In this review:`,
    "",
    `- \`<unvibed>\` is \`${unvibed}\`. The change is \`git diff ${at.base} ${at.head}\`; read it with get_hunk, get_code and your file tools.`,
    "- You can't run commands here, so instead of running graph check, call write_graph with the whole graph. Leave ids, `schema` and a location's `hash` blank (\"\") to have them filled in; write_graph answers with graph check's report. Call it again until the report has no ✗. Don't open the viewer.",
    "- The PR's description is below, for why the change was made. Ignore any graph it links to or holds.",
    "",
    "## Description",
    "",
    description || "(none)",
  ];
  if (old)
    lines.push(
      "",
      "## The graph so far",
      "",
      `This graph was written for an earlier head, ${old.head}; the change has moved since. Update it for the change as it is now, as the guide says for a graph that grows for a later commit.`,
      ...(old.keep.length
        ? ["", "The reviewer has reviewed or commented on these; write_graph fails while any is missing:", "", ...old.keep.map((k) => `- ${k.location ? `location ${k.location}` : `node ${k.node}`} (${k.why})${k.quote ? `, quoting "${k.quote}"` : ""}${k.now ? `, now at ${k.now.path}:${k.now.start_line}-${k.now.line} (${k.now.side})` : ""}`)]
        : []),
      "",
      "```json",
      JSON.stringify(old.graph, null, 2),
      "```",
    );
  return lines.join("\n");
}

/** Each node is a card; its text and each location's explanation are paragraph blocks, ids kept. */
export function graphToPage(graph: Graph): Page {
  const paragraph = (id: string, text: string) => ({ type: "paragraph" as const, id, text: { standard: text }, citations: [] });
  const cards: Card[] = graph.nodes.map((node) => ({
    id: node.id,
    pageId: GRAPH_PAGE_ID,
    title: node.title,
    collapsed: false,
    blocks: [paragraph(node.id, node.text), ...node.code.map((l) => paragraph(l.id, l.text))],
    level: "standard",
    revision: 1,
    undoStack: [],
  }));
  return { id: GRAPH_PAGE_ID, kind: "graph", title: "Graph", cards } as Page;
}

export async function registerUnvibed(app: FastifyInstance, ctx: ServiceContext): Promise<void> {
  const full = ctx as unknown as AppContext;
  const graphFile = (id: string) => path.join(ctx.dataDir, "unvibed", `${id}.json`);
  /** The head a stored graph was written for. */
  const headFile = (id: string) => path.join(ctx.dataDir, "unvibed", `${id}.head`);
  const where = (id: string) => {
    const snap = ctx.reviews.getSnapshot(id);
    if (!snap?.version?.headSha) return null;
    const repo = cwdForReview(ctx, id, snap.review.repoId);
    if (!repo) return null;
    return { repo, base: snap.version.mergeBaseSha, head: snap.version.headSha };
  };
  const stores = new Map<string, MarkStore>();
  const marksFor = (repo: string) => {
    if (!stores.has(repo)) stores.set(repo, new MarkStore(repo));
    return stores.get(repo)!;
  };

  const stored = (id: string): { graph: Graph; head: string } | undefined => {
    if (!fs.existsSync(graphFile(id))) return undefined;
    const head = fs.existsSync(headFile(id)) ? fs.readFileSync(headFile(id), "utf8").trim() : "";
    return { graph: JSON.parse(fs.readFileSync(graphFile(id), "utf8")) as Graph, head };
  };
  /** Whether graph passes graph check at at: every location matches, every id is a UUID of its own, every edge joins two nodes. */
  const passes = (graph: Graph, at: At) =>
    !check(at.repo, graph, (side, p) => show(at.repo, side === "LEFT" ? at.base : at.head, p)).length && !checkIds(graph).length && !checkEdgeEnds(graph).length;
  const save = async (id: string, at: At, graph: Graph) => {
    fs.mkdirSync(path.dirname(graphFile(id)), { recursive: true });
    fs.writeFileSync(graphFile(id), JSON.stringify(graph));
    fs.writeFileSync(headFile(id), at.head);
    const page = graphToPage(graph);
    await ctx.reviews.mutate(id, (draft) => {
      draft.pages = [...draft.pages.filter((p) => p.id !== GRAPH_PAGE_ID), page];
    });
    return page;
  };

  const unvibed = findUnvibed();
  const schema = execFileSync("git", ["hash-object", path.join(unvibed, "shared", "graph.ts")], { encoding: "utf8" }).trim();

  /** What reviewing left on a review's graph: its ticked hashes, and its threads on node and location text. */
  const reviewedOf = (id: string, at: At): Reviewed => {
    const threads: Reviewed["threads"] = [];
    for (const t of ctx.reviews.getSnapshot(id)?.annotations ?? []) {
      if (t.type !== "thread" && t.type !== "link") continue;
      const host = t.anchor.host;
      if (host.kind !== "block") continue;
      const [node, block] = host.blockId.split("#");
      if (!node || !block) continue;
      threads.push({ node, ...(block !== node ? { location: block } : {}), quote: t.anchor.quotedText });
    }
    return { ticks: new Set(marksFor(at.repo).reviewedHashes(id)), threads };
  };

  /** A review's graph job: the head it writes for, and where it stands; one at a time per review. */
  type Job = { at: At; keep: Keep[]; state: "writing" | "failed"; error?: string; draft?: Graph; writes: number; stop: AbortController };
  const jobs = new Map<string, Job>();

  full.mcp.setGraphWriter(async (id, graph) => {
    const job = jobs.get(id);
    if (!job || job.state !== "writing") return "No graph is being written for this review.";
    if (!graph || typeof graph !== "object" || !Array.isArray((graph as Graph).nodes) || !Array.isArray((graph as Graph).edges))
      return "write_graph takes the whole graph: { schema, nodes, edges }.";
    job.writes++;
    job.draft = fillBlanks(graph as Graph, job.at, schema);
    const report = graphReport(job.draft, job.at, job.keep);
    return report.passes ? `${report.text}\n\nThe graph passes graph check; it is shown once you finish your turn.` : report.text;
  });

  /** Writes a graph for at, or updates old for it, until a draft passes or the budget runs out. */
  const runJob = async (id: string, job: Job, old: { graph: Graph; head: string } | undefined) => {
    const signal = AbortSignal.any([job.stop.signal, AbortSignal.timeout(GRAPH_BUDGET_MS)]);
    const snap = ctx.reviews.getSnapshot(id);
    const description = (snap?.description?.baseMarkdown ?? snap?.description?.html.replace(/<[^>]+>/g, "") ?? "")
      .split("\n")
      .filter((l) => !l.includes("unvibed-graph"))
      .join("\n");
    try {
      const session = await full.pipeline.graphSession(id);
      try {
        let text = graphPrompt(unvibed, job.at, description, old && { ...old, keep: job.keep });
        // turns in a row that ended without a write_graph call; the second, after a reminder, ends the job
        let idle = 0;
        for (;;) {
          const writes = job.writes;
          await session.prompt(text, signal);
          // never hold up the service between turns, however fast they come back
          await new Promise((r) => setImmediate(r));
          const report = job.draft && graphReport(job.draft, job.at, job.keep);
          if (job.draft && report?.passes) {
            await save(id, job.at, job.draft);
            jobs.delete(id);
            return;
          }
          signal.throwIfAborted();
          idle = job.writes === writes ? idle + 1 : 0;
          if (idle >= 2) throw new Error("The agent ended its turns without calling write_graph, even when reminded to.");
          text = report
            ? `Your graph doesn't pass graph check yet. Fix it and call write_graph again with the whole graph:\n\n${report.text}`
            : "You haven't called write_graph yet. Write the graph and call write_graph with it.";
        }
      } finally {
        await session.close();
      }
    } catch (err) {
      if (jobs.get(id) !== job) return; // replaced by a job for a newer head
      job.state = "failed";
      job.error = signal.aborted && !job.stop.signal.aborted ? `Writing the graph took longer than its ${Math.round(GRAPH_BUDGET_MS / 60_000)} minutes.` : (err as Error).message;
    }
  };

  /**
   * Where a review's graph stands at its current version: ready, or ready and being updated for a newer head; otherwise
   * a graph is being written (or failed to be). Starts the job when the graph needs one and none is running for this
   * head; retry starts one again after a failure.
   */
  const graphState = (id: string, at: At, retry: boolean) => {
    const have = stored(id);
    const shown = have && passes(have.graph, at);
    const current = have && have.head === at.head && shown;
    let job = jobs.get(id);
    if (job && job.at.head !== at.head) {
      job.stop.abort();
      jobs.delete(id);
      job = undefined;
    }
    if (job?.state === "failed" && retry) {
      jobs.delete(id);
      job = undefined;
    }
    if (!current && !job) {
      job = { at, keep: have ? reviewedToKeep(have.graph, reviewedOf(id, at), at) : [], state: "writing", writes: 0, stop: new AbortController() };
      jobs.set(id, job);
      void runJob(id, job, have);
    }
    // a graph that still passes stays shown when its update fails, with why
    if (shown) return job?.state === "failed" ? { state: "ready", error: job.error } : { state: job ? "updating" : "ready" };
    return job!.state === "failed" ? { state: "failed", error: job!.error } : { state: "writing" };
  };

  // ---- risk: an opt-in AI reviewer's rating of each location, laid over the graph by the page ----

  const riskFile = (id: string) => path.join(ctx.dataDir, "unvibed", `${id}.risk.json`);
  const readRisk = (id: string): RiskFile =>
    fs.existsSync(riskFile(id)) ? (JSON.parse(fs.readFileSync(riskFile(id), "utf8")) as RiskFile) : { on: false, byKey: {} };
  const writeRisk = (id: string, risk: RiskFile) => {
    fs.mkdirSync(path.dirname(riskFile(id)), { recursive: true });
    fs.writeFileSync(riskFile(id), JSON.stringify(risk));
  };

  /** A review's risk-rating job: the graph it rates, and where it stands; one at a time per review. */
  type RiskJob = { graph: Graph; state: "rating" | "failed"; error?: string; ratings: number; stop: AbortController };
  const riskJobs = new Map<string, RiskJob>();

  full.mcp.setRiskWriter(async (id, input) => {
    const job = riskJobs.get(id);
    if (!job || job.state !== "rating") return "No risk rating is under way for this review.";
    const { ratings, problems } = readRatings(input, job.graph);
    const risk = readRisk(id);
    writeRisk(id, { ...risk, byKey: { ...risk.byKey, ...ratings } });
    job.ratings += Object.keys(ratings).length;
    const left = unrated(job.graph, readRisk(id).byKey);
    return [
      `Recorded ${Object.keys(ratings).length} rating(s).`,
      ...problems,
      left.length ? `Still to rate: ${left.join(", ")}` : "Every location is rated; finish your turn.",
    ].join("\n");
  });

  /** Rates every location of graph that has no rating yet, until none is left or the budget runs out. */
  const runRisk = async (id: string, job: RiskJob, at: At) => {
    const signal = AbortSignal.any([job.stop.signal, AbortSignal.timeout(GRAPH_BUDGET_MS)]);
    try {
      const session = await full.pipeline.graphSession(id, "risk");
      try {
        let text = riskPrompt(job.graph, at, unrated(job.graph, readRisk(id).byKey));
        // turns in a row that ended without a rating; the second, after a reminder, ends the job
        let idle = 0;
        for (;;) {
          const ratings = job.ratings;
          await session.prompt(text, signal);
          await new Promise((r) => setImmediate(r));
          const left = unrated(job.graph, readRisk(id).byKey);
          if (!left.length) {
            riskJobs.delete(id);
            return;
          }
          signal.throwIfAborted();
          idle = job.ratings === ratings ? idle + 1 : 0;
          if (idle >= 2) throw new Error("The agent ended its turns without rating every location, even when reminded to.");
          text = `These locations aren't rated yet. Rate them with rate_risk: ${left.join(", ")}`;
        }
      } finally {
        await session.close();
      }
    } catch (err) {
      if (riskJobs.get(id) !== job) return; // replaced by a job for a newer graph
      job.state = "failed";
      job.error = signal.aborted && !job.stop.signal.aborted ? `Rating risk took longer than its ${Math.round(GRAPH_BUDGET_MS / 60_000)} minutes.` : (err as Error).message;
    }
  };

  /**
   * Where risk stands for a review's shown graph: off, rated, or being rated (or failed to be). While it's on, starts a
   * job for the shown graph's unrated locations when none is running; retry starts one again after a failure.
   */
  const riskState = (id: string, at: At, retry: boolean) => {
    const risk = readRisk(id);
    const have = stored(id);
    const shown = have && passes(have.graph, at) ? have.graph : undefined;
    let job = riskJobs.get(id);
    if (job && (!risk.on || JSON.stringify(job.graph) !== JSON.stringify(shown))) {
      job.stop.abort();
      riskJobs.delete(id);
      job = undefined;
    }
    if (job?.state === "failed" && retry) {
      riskJobs.delete(id);
      job = undefined;
    }
    if (!risk.on) return { on: false };
    if (!shown) return { on: true, state: "waiting", risks: {} };
    if (!job && unrated(shown, risk.byKey).length) {
      job = { graph: shown, state: "rating", ratings: 0, stop: new AbortController() };
      riskJobs.set(id, job);
      void runRisk(id, job, at);
    }
    const risks = risksById(shown, readRisk(id).byKey);
    if (!job) return { on: true, state: "ready", risks };
    return job.state === "failed" ? { on: true, state: "failed", error: job.error, risks } : { on: true, state: "rating", risks };
  };

  app.get("/api/reviews/:id/unvibed/risk", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    return riskState(id, at, false);
  });

  // turns the risk reviewer on (starting it, or starting it again after a failure) or off; ratings are kept either way
  app.post("/api/reviews/:id/unvibed/risk", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as { on?: unknown };
    if (typeof body?.on !== "boolean") return reply.code(400).send({ error: "send { on: true } or { on: false }" });
    writeRisk(id, { ...readRisk(id), on: body.on });
    return riskState(id, at, true);
  });

  app.post("/api/reviews/:id/unvibed/graph", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    const graph = req.body as Graph;
    const problems = check(at.repo, graph, (side, p) => show(at.repo, side === "LEFT" ? at.base : at.head, p));
    const ids = checkIds(graph);
    const ends = checkEdgeEnds(graph);
    if (problems.length || ids.length || ends.length) return reply.code(400).send({ problems, ids, ends });
    const page = await save(id, at, graph);
    return { ok: true, cards: page.cards.length };
  });

  // never a graph that fails graph check at the review's current version
  app.get("/api/reviews/:id/unvibed/graph.json", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    const have = stored(id);
    if (!have) return reply.code(404).send({ error: "no graph" });
    if (!passes(have.graph, at)) return reply.code(404).send({ error: "the graph doesn't match this version of the change" });
    return have.graph;
  });

  app.get("/api/reviews/:id/unvibed/state", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    return graphState(id, at, false);
  });

  app.post("/api/reviews/:id/unvibed/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    return graphState(id, at, true);
  });

  app.get("/api/reviews/:id/unvibed/reviewed", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    return marksFor(at.repo).reviewedHashes(id);
  });

  app.get("/api/reviews/:id/unvibed/code", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    const query = CodeQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send(z.prettifyError(query.error));
    const { path: file, side, start, end, above, below } = query.data;
    return isRepoFile(at.repo, side === "LEFT" ? at.base : at.head, file)
      ? cutFor(at.repo, file, side, start, end, above, below, at.base, at.head)
      : EMPTY_CUT;
  });

  app.post("/api/reviews/:id/unvibed/mark", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const request = MarkRequest.safeParse(body);
    if (!request.success) return reply.code(400).send(z.prettifyError(request.error));
    marksFor(at.repo).mark(id, request.data.hash, request.data.reviewed);
    return "ok";
  });
}
