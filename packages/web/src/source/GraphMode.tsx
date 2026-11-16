/**
 * Graph mode (prototype): unvibed's graph as a section of the guide, under Plotlines, with
 * Unvibe's threads on it. unvibed draws the graph, text, code, selection
 * buttons and quote marks; this file gives it Unvibe's threads (list), the
 * toolbar's actions, ThreadView / NewThreadComposer (render) and reopen /
 * close (setOpen).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionAnchor } from "@unvibe/shared";
import { api, friendlyError } from "../api/client.js";
import { NewThreadComposer } from "../comments/NewThreadComposer.js";
import { ThreadView } from "../comments/ThreadView.js";
import { ErrorBoundary, InlineFallback } from "../components/ErrorBoundary.js";
import { WorkingPlaceholder } from "../components/WorkingPlaceholder.js";
import { Card } from "../ui/index.js";
import { explainSelection, selectionActions } from "../floating/SelectionToolbar.js";
import { toast } from "../floating/Toast.js";
import { GRAPH_NODE_EVENT, type GraphNodeRequest } from "../guide/actions.js";
import { inflightForAnchor, inflightLabel } from "../guide/inflight.js";
import { useReview } from "../state/store.js";
import { GraphReview, type Graph, type Place, type ThreadItem, type Threads } from "@unvibed/viewer";
import { placeToAnchor, threadPlace } from "./graphPlace.js";

/** The opt-in risk reviewer: off, or on and rating (or waiting for a graph), rated, or failed; ratings by location id. */
type Risk = NonNullable<Graph["nodes"][number]["code"][number]["risk"]>;
type RiskState = { on: false } | { on: true; state: "waiting" | "rating" | "ready" | "failed"; error?: string; risks: Record<string, Risk> };

type Pending = { id: string; at: Place; anchor: ActionAnchor; quote: string; kind: "ask" | "comment"; offsets?: { start: number; end: number } };

/**
 * Graph mode's section of the guide, beside Plotlines: the graph across the guide's width, and a full-screen mode that
 * covers the window, for reviewing the code diffs. Esc, or the button, leaves full screen.
 */
export function GraphSection({ reviewId }: { reviewId: string }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  const box: React.CSSProperties = full
    ? { position: "fixed", inset: 0, zIndex: 1000, background: "var(--bg)" }
    : { position: "relative", height: "70vh" };
  return (
    <Card as="section" variant="inset" className="plotlines" aria-label="Graph" data-graph-section>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2>Graph</h2>
        <button className="x" type="button" onClick={() => setFull(true)}>
          Full screen
        </button>
      </div>
      <div style={box} data-graph-full={full || undefined}>
        {full && (
          <button className="x" type="button" style={{ position: "absolute", top: 8, left: 8, zIndex: 10 }} onClick={() => setFull(false)}>
            Exit full screen
          </button>
        )}
        {/* the canvas fits itself when drawn, so it's drawn afresh at each size */}
        <GraphMode reviewId={reviewId} fitKey={full ? "full" : "inline"} />
      </div>
    </Card>
  );
}

export function GraphMode({ reviewId, fitKey }: { reviewId: string; fitKey?: string }) {
  const snapshot = useReview((s) => s.snapshot);
  const inflight = useReview((s) => s.inflight);
  const [graph, setGraph] = useState<Graph>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [explains, setExplains] = useState<{ id: string; at: Place; anchor: ActionAnchor; quote: string }[]>([]);
  const routes = `/api/reviews/${reviewId}/unvibed`;

  const base = snapshot?.version?.mergeBaseSha ?? "";
  const head = snapshot?.version?.headSha ?? "";
  const [writing, setWriting] = useState<"writing" | "failed">();
  const [attempt, setAttempt] = useState(0);
  const shownText = useRef("");
  const [risk, setRisk] = useState<RiskState>();
  const [riskTurn, setRiskTurn] = useState<{ on: boolean; n: number }>();

  // The graph's state at this head: asking starts the agent when there's no graph, or the head moved since it was
  // written. A graph that's ready, or still passes graph check while it's updated, is shown; until then, that it's
  // being written. Asked again every 2 seconds until it's ready.
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (first: boolean) => {
      try {
        const r = await fetch(`${routes}/${first && attempt ? "retry" : "state"}`, { method: first && attempt ? "POST" : "GET" });
        if (!r.ok) throw new Error(await r.text());
        const s = (await r.json()) as { state: "ready" | "updating" | "writing" | "failed"; error?: string };
        if (!current) return;
        if (s.state === "failed") {
          setWriting("failed");
          setError(s.error ?? "The graph couldn't be written.");
          return;
        }
        if (s.state === "writing") {
          shownText.current = "";
          setGraph(undefined);
          setWriting("writing");
        } else {
          const g = await fetch(`${routes}/graph.json`);
          const text = g.ok ? await g.text() : "";
          // a new graph only when it changed, so asking again while it's updated doesn't redraw it
          if (current && text && text !== shownText.current) {
            shownText.current = text;
            setGraph(JSON.parse(text) as Graph);
            setGraphText(text);
          }
          setWriting(undefined);
        }
        if (s.state !== "ready") timer = setTimeout(() => void ask(false), 2000);
      } catch (e) {
        if (current) setError((e as Error).message);
      }
    };
    setError(undefined);
    void ask(true);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [routes, head, attempt]);

  // The risk reviewer's state for the shown graph, asked again every 2 seconds while it rates; turning it on or off
  // (riskTurn) is sent first. Asked afresh whenever a new graph is shown, since that may need rating.
  const [graphText, setGraphText] = useState("");
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (first: boolean) => {
      try {
        const r = first && riskTurn
          ? await fetch(`${routes}/risk`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: riskTurn.on }) })
          : await fetch(`${routes}/risk`);
        if (!r.ok) throw new Error(await r.text());
        const next = (await r.json()) as RiskState;
        if (!current) return;
        // a new state only when it changed, so asking again doesn't redraw the graph
        setRisk((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
        if (next.on && (next.state === "rating" || next.state === "waiting")) timer = setTimeout(() => void ask(false), 2000);
      } catch (e) {
        if (current) toast(`Couldn't get the risk ratings: ${(e as Error).message}`);
      }
    };
    void ask(true);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [routes, riskTurn, graphText]);

  // the graph as shown: with the risk reviewer on, each rated location carries its rating
  const shown = useMemo((): Graph | undefined => {
    if (!graph || !risk?.on) return graph;
    const rated = (l: Graph["nodes"][number]["code"][number]) => (risk.risks[l.id] ? { ...l, risk: risk.risks[l.id] } : l);
    return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, code: n.code.map(rated) })) };
  }, [graph, risk]);

  // A jump to a thread (from the comments menu or a link) opens its node here: the node itself for a thread on node or
  // location text, and for a thread on code, the first node with a location on that side covering its lines.
  useEffect(() => {
    const onRequest = (e: Event): void => {
      const request = (e as CustomEvent<GraphNodeRequest>).detail;
      let nodeId: string | undefined;
      if ("nodeId" in request) nodeId = request.nodeId;
      else {
        const { path, commit, start, end } = request.code;
        const side = commit === head ? "RIGHT" : commit === base ? "LEFT" : undefined;
        const covers = (l: Graph["nodes"][number]["code"][number]) =>
          l.path === path && l.side === side && (l.start_line ?? l.line) <= start && end <= l.line;
        nodeId = graph?.nodes.find((n) => n.code.some(covers))?.id;
      }
      if (!nodeId) return;
      setSelected(nodeId);
      document.querySelector("[data-graph-section]")?.scrollIntoView({ block: "start" });
    };
    window.addEventListener(GRAPH_NODE_EVENT, onRequest);
    return () => window.removeEventListener(GRAPH_NODE_EVENT, onRequest);
  }, [graph, base, head]);

  const threads = useMemo((): Threads | undefined => {
    if (!graph || !snapshot) return undefined;
    const cards = new Set(graph.nodes.map((n) => n.id));
    const version = { mergeBaseSha: base, headSha: head };
    const items: ThreadItem[] = [];
    for (const t of snapshot.annotations) {
      if (t.type !== "thread" && t.type !== "link") continue;
      const at = threadPlace(t, cards, version);
      if (!at) continue;
      items.push({
        id: t.id,
        at,
        quote: t.anchor.quotedText,
        ...(t.anchor.startOffset !== undefined && t.anchor.endOffset !== undefined ? { offsets: { start: t.anchor.startOffset, end: t.anchor.endOffset } } : {}),
        open: t.open,
      });
    }
    // an Explain in flight shows where its thread will land, until the thread does (GuideBlockThreads' rule)
    const working: { id: string; label: string }[] = [];
    for (const e of explains) {
      if (!inflightForAnchor(inflight, e.anchor)) continue;
      const arrived = items.some((i) => i.open && JSON.stringify(i.at) === JSON.stringify(e.at) && i.quote === e.quote);
      if (arrived) continue;
      items.push({ id: e.id, at: e.at, quote: e.quote, open: true });
      working.push({ id: e.id, label: inflightLabel("explain") });
    }
    for (const p of pending) items.push({ id: p.id, at: p.at, quote: p.quote, ...(p.offsets ? { offsets: p.offsets } : {}), open: true });

    return {
      list: items,
      actions: ({ at, quote, offsets }) =>
        selectionActions({}).map((a) => ({
          label: a.label,
          run: () => {
            const anchor = placeToAnchor(at, version);
            if (a.id === "explain") {
              setExplains((es) => [...es, { id: `working:${Date.now()}`, at, anchor, quote }]);
              explainSelection(reviewId, { quote, anchor, ...(offsets ? { offsets } : {}) });
            }
            else setPending((ps) => [...ps, { id: `pending:${Date.now()}`, at, anchor, quote, kind: a.id === "ask" ? "ask" : "comment", ...(offsets ? { offsets } : {}) }]);
          },
        })),
      render: (id) => {
        const p = pending.find((x) => x.id === id);
        if (p)
          return (
            <NewThreadComposer
              reviewId={reviewId}
              anchor={p.anchor}
              quote={p.quote}
              kind={p.kind}
              offsets={p.offsets}
              onDiscard={() => setPending((ps) => ps.filter((x) => x.id !== id))}
              onCreated={(created) => {
                setPending((ps) => ps.filter((x) => x.id !== id));
                if (p.kind === "comment") api.updateComment(reviewId, created, { open: true }).catch(() => {});
              }}
            />
          );
        const w = working.find((x) => x.id === id);
        if (w) return <WorkingPlaceholder label={w.label} />;
        const t = snapshot.annotations.find((x) => x.id === id);
        return t ? <ThreadView reviewId={reviewId} thread={t} /> : null;
      },
      setOpen: (id, open) => {
        api.updateComment(reviewId, id, { open }).catch((err: unknown) => toast(`Couldn't ${open ? "open" : "close"} the thread: ${friendlyError(err)}`));
      },
    };
  }, [graph, snapshot, inflight, pending, explains, reviewId, base, head]);

  if (error)
    return (
      <p className="hint" style={{ padding: 16 }}>
        {error}{" "}
        {writing === "failed" && (
          <button className="x" type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        )}
      </p>
    );
  if (writing === "writing")
    return (
      <div style={{ padding: 16 }}>
        <WorkingPlaceholder label="Writing the graph…" />
      </div>
    );
  if (!shown || !threads) return null;
  const turnRisk = (on: boolean) => setRiskTurn((t) => ({ on, n: (t?.n ?? 0) + 1 }));
  return (
    <div style={{ position: "relative", height: "100%" }} data-graph-mode>
      <div style={{ position: "absolute", left: 8, bottom: 8, zIndex: 10, display: "flex", gap: 8, alignItems: "center" }} data-risk-overlay>
        {!risk?.on ? (
          <button className="x" type="button" onClick={() => turnRisk(true)} title="An AI reviewer rates how risky each location's lines are">
            Rate risk
          </button>
        ) : (
          <>
            <button className="x" type="button" onClick={() => turnRisk(false)}>
              Hide risk
            </button>
            {risk.state === "rating" || risk.state === "waiting" ? <WorkingPlaceholder label="Rating risk…" /> : null}
            {risk.state === "failed" ? (
              <span className="hint">
                {risk.error ?? "Rating risk failed."}{" "}
                <button className="x" type="button" onClick={() => turnRisk(true)}>
                  Try again
                </button>
              </span>
            ) : null}
          </>
        )}
      </div>
      <ErrorBoundary
        name="graph-mode"
        resetKey={`${reviewId}:${selected ?? ""}`}
        fallback={({ reset }) => (
          <InlineFallback
            message="Couldn't show the graph: something went wrong"
            onRetry={() => {
              setSelected(undefined);
              reset();
            }}
          />
        )}
      >
        <GraphReview key={fitKey} graph={shown} host={{ routes }} threads={threads} selected={selected} onSelect={setSelected} />
      </ErrorBoundary>
    </div>
  );
}
