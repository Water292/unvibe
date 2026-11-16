/**
 * unvibed graph mode (prototype): stores a review's graph, turns its nodes
 * into guide cards (so `block` anchors resolve and agents get the text), and
 * mounts unvibed's /code, /reviewed and /mark under
 * /api/reviews/:id/unvibed/.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Card, Page } from "@unvibe/shared";
import { z } from "zod/v4";
import type { ServiceContext } from "./context.js";
import { cwdForReview } from "./files.js";
// unvibed's server code, from its checkout beside this one (prototype: no package yet)
import { cutFor, EMPTY_CUT } from "../../../../../../unvibed-graph/src/hunks.ts";
import { isRepoFile, show } from "../../../../../../unvibed-graph/src/git.ts";
import { ReviewStore as MarkStore } from "../../../../../../unvibed-graph/src/review.ts";
import { check, checkEdgeEnds, checkIds } from "../../../../../../unvibed-graph/src/check.ts";
import { CodeQuery, MarkRequest } from "../../../../../../unvibed-graph/shared/graph-and-code.ts";
import type { Graph } from "../../../../../../unvibed-graph/shared/graph.ts";

export const GRAPH_PAGE_ID = "graph";

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
  const graphFile = (id: string) => path.join(ctx.dataDir, "unvibed", `${id}.json`);
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

  app.post("/api/reviews/:id/unvibed/graph", async (req, reply) => {
    const { id } = req.params as { id: string };
    const at = where(id);
    if (!at) return reply.code(409).send({ error: "review not ready" });
    const graph = req.body as Graph;
    const problems = check(at.repo, graph, (side, p) => show(at.repo, side === "LEFT" ? at.base : at.head, p));
    const ids = checkIds(graph);
    const ends = checkEdgeEnds(graph);
    if (problems.length || ids.length || ends.length) return reply.code(400).send({ problems, ids, ends });
    fs.mkdirSync(path.dirname(graphFile(id)), { recursive: true });
    fs.writeFileSync(graphFile(id), JSON.stringify(graph));
    const page = graphToPage(graph);
    await ctx.reviews.mutate(id, (draft) => {
      draft.pages = [...draft.pages.filter((p) => p.id !== GRAPH_PAGE_ID), page];
    });
    return { ok: true, cards: page.cards.length };
  });

  app.get("/api/reviews/:id/unvibed/graph.json", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!fs.existsSync(graphFile(id))) return reply.code(404).send({ error: "no graph" });
    return JSON.parse(fs.readFileSync(graphFile(id), "utf8"));
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
