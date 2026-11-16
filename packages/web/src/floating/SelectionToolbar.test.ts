/**
 * Scroll-grace logic for the selection toolbar (issues #147, #319): a
 * scroll landing between `setPending` and the React commit must not hide
 * a bar whose selection is still live, so grace is decided from the
 * synchronously set `shownAt` plus a live-selection check.
 */
import { describe, expect, it } from "vitest";
import { inSelectionScope, isInScrollGrace, SCROLL_GRACE_MS, selectionActions } from "./SelectionToolbar.js";

const SHOWN_AT = 10_000;

describe("isInScrollGrace", () => {
  it("is false when the bar was never requested", () => {
    expect(isInScrollGrace(SHOWN_AT, 0, true)).toBe(false);
  });

  it("is true within the grace window while the selection is live", () => {
    expect(isInScrollGrace(SHOWN_AT, SHOWN_AT, true)).toBe(true);
    expect(isInScrollGrace(SHOWN_AT + SCROLL_GRACE_MS - 1, SHOWN_AT, true)).toBe(true);
  });

  it("is false once the grace window has passed", () => {
    expect(isInScrollGrace(SHOWN_AT + SCROLL_GRACE_MS, SHOWN_AT, true)).toBe(false);
    expect(isInScrollGrace(SHOWN_AT + SCROLL_GRACE_MS + 500, SHOWN_AT, true)).toBe(false);
  });

  it("is false when the selection is no longer live, even within the window", () => {
    expect(isInScrollGrace(SHOWN_AT + 10, SHOWN_AT, false)).toBe(false);
  });

  it("is false for a stale timestamp after the bar was dismissed and re-requested never happened", () => {
    expect(isInScrollGrace(SHOWN_AT + SCROLL_GRACE_MS * 4, SHOWN_AT, true)).toBe(false);
  });
});

// Graph mode (prototype) offers the toolbar's own actions, from the same list.
describe("selectionActions", () => {
  it("is Explain, Ask and Comment, in the toolbar's order", () => {
    expect(selectionActions({}).map((a) => [a.id, a.label])).toEqual([
      ["explain", "Explain"],
      ["ask", "Ask…"],
      ["comment", "Comment"],
    ]);
  });

  it("has no Comment on revealed lines", () => {
    expect(selectionActions({ revealed: true }).map((a) => a.id)).toEqual(["explain", "ask"]);
  });
});

// Text selected inside a thread gets the toolbar wherever the thread is drawn, as in graph mode's right pane.
describe("inSelectionScope", () => {
  it("includes a thread outside the page and the source pane", () => {
    document.body.innerHTML = '<div id="right"><div data-graph-mode><div class="ithread"><p id="in">reply</p></div><p id="out">node text</p></div></div>';
    expect(inSelectionScope(document.getElementById("in")!)).toBe(true);
    expect(inSelectionScope(document.getElementById("out")!)).toBe(false);
  });
});
