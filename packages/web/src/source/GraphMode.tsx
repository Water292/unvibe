/**
 * Graph mode (prototype): unvibed's graph in place of the source pane, with
 * Unvibe's threads on it. unvibed draws the graph, text, code, selection
 * buttons and quote marks; this file gives it Unvibe's threads (list), the
 * toolbar's actions, ThreadView / NewThreadComposer (render) and reopen /
 * close (setOpen).
 */
import { useEffect, useMemo, useState } from "react";
import type { ActionAnchor } from "@unvibe/shared";
import { api, friendlyError } from "../api/client.js";
import { NewThreadComposer } from "../comments/NewThreadComposer.js";
import { ThreadView } from "../comments/ThreadView.js";
import { ErrorBoundary, InlineFallback } from "../components/ErrorBoundary.js";
import { WorkingPlaceholder } from "../components/WorkingPlaceholder.js";
import { explainSelection, selectionActions } from "../floating/SelectionToolbar.js";
import { toast } from "../floating/Toast.js";
import { inflightForAnchor, inflightLabel } from "../guide/inflight.js";
import { useReview } from "../state/store.js";
import { GraphReview, type Graph, type Place, type ThreadItem, type Threads } from "@unvibed/viewer";
import { placeToAnchor, threadPlace } from "./graphPlace.js";

type Pending = { id: string; at: Place; anchor: ActionAnchor; quote: string; kind: "ask" | "comment"; offsets?: { start: number; end: number } };

export function GraphMode({ reviewId }: { reviewId: string }) {
  const snapshot = useReview((s) => s.snapshot);
  const inflight = useReview((s) => s.inflight);
  const [graph, setGraph] = useState<Graph>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [explains, setExplains] = useState<{ id: string; at: Place; anchor: ActionAnchor; quote: string }[]>([]);
  const routes = `/api/reviews/${reviewId}/unvibed`;

  useEffect(() => {
    let current = true;
    fetch(`${routes}/graph.json`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await r.text()))))
      .then((g: Graph) => current && setGraph(g), (e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [routes]);

  const base = snapshot?.version?.mergeBaseSha ?? "";
  const head = snapshot?.version?.headSha ?? "";

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

  if (error) return <p className="hint" style={{ padding: 16 }}>{error}</p>;
  if (!graph || !threads) return null;
  return (
    <div style={{ position: "relative", height: "100%" }} data-graph-mode>
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
        <GraphReview graph={graph} host={{ routes }} threads={threads} selected={selected} onSelect={setSelected} />
      </ErrorBoundary>
    </div>
  );
}
