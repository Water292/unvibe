import { describe, expect, it } from "vitest";
import type { Thread } from "@unvibe/shared";
import { placeToAnchor, threadPlace } from "./graphPlace.js";

const version = { mergeBaseSha: "base0", headSha: "head0" };
const cards = new Set(["n"]);
const thread = (host: Thread["anchor"]["host"]) => ({ anchor: { host } }) as Thread;

describe("placeToAnchor", () => {
  it("names a node's text by its card and the node's own block", () => {
    expect(placeToAnchor({ node: "n" }, version)).toEqual({ where: "block", blockId: "n#n" });
  });
  it("names a location's text by the node's card and the location's block", () => {
    expect(placeToAnchor({ node: "n", location: "l" }, version)).toEqual({ where: "block", blockId: "n#l" });
  });
  it("puts base-side lines at the merge base and head-side lines at the head", () => {
    expect(placeToAnchor({ code: { path: "a.ts", side: "LEFT", start: 8, end: 9 } }, version)).toEqual({ where: "code", path: "a.ts", commit: "base0", line: 8, endLine: 9 });
    expect(placeToAnchor({ code: { path: "a.ts", side: "RIGHT", start: 21, end: 21 } }, version)).toEqual({ where: "code", path: "a.ts", commit: "head0", line: 21 });
  });
});

describe("threadPlace", () => {
  it("reads a block anchor on a graph card back as the node or the location", () => {
    expect(threadPlace(thread({ kind: "block", blockId: "n#n" }), cards, version)).toEqual({ node: "n" });
    expect(threadPlace(thread({ kind: "block", blockId: "n#l" }), cards, version)).toEqual({ node: "n", location: "l" });
  });
  it("leaves out blocks on other pages' cards", () => {
    expect(threadPlace(thread({ kind: "block", blockId: "other#b1" }), cards, version)).toBeUndefined();
  });
  it("reads a code anchor's commit back as its side, and leaves out other commits", () => {
    expect(threadPlace(thread({ kind: "code", path: "a.ts", commit: "base0", line: 8, endLine: 9 }), cards, version)).toEqual({ code: { path: "a.ts", side: "LEFT", start: 8, end: 9 } });
    expect(threadPlace(thread({ kind: "code", path: "a.ts", commit: "head0", line: 21 }), cards, version)).toEqual({ code: { path: "a.ts", side: "RIGHT", start: 21, end: 21 } });
    expect(threadPlace(thread({ kind: "code", path: "a.ts", commit: "older", line: 21 }), cards, version)).toBeUndefined();
  });
});
