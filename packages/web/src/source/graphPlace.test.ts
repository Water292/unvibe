import { describe, expect, it } from "vitest";
import type { Thread } from "@unvibe/shared";
import { coversCode, diffShowsLine, placeToAnchor, threadPlace } from "./graphPlace.js";
import type { ReviewFile } from "@unvibe/shared";

const version = { mergeBaseSha: "base0", headSha: "head0" };
const cards = new Set(["n"]);
const thread = (host: Thread["anchor"]["host"]) => ({ anchor: { host } }) as Thread;
const pathOf = (fileKey: string) => (fileKey === "a-ts" ? "a.ts" : undefined);

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
    expect(threadPlace(thread({ kind: "block", blockId: "n#n" }), cards, version, pathOf)).toEqual({ node: "n" });
    expect(threadPlace(thread({ kind: "block", blockId: "n#l" }), cards, version, pathOf)).toEqual({ node: "n", location: "l" });
  });
  it("leaves out blocks on other pages' cards", () => {
    expect(threadPlace(thread({ kind: "block", blockId: "other#b1" }), cards, version, pathOf)).toBeUndefined();
  });
  it("reads a code anchor's commit back as its side, and leaves out other commits", () => {
    expect(threadPlace(thread({ kind: "code", path: "a.ts", commit: "base0", line: 8, endLine: 9 }), cards, version, pathOf)).toEqual({ code: { path: "a.ts", side: "LEFT", start: 8, end: 9 } });
    expect(threadPlace(thread({ kind: "code", path: "a.ts", commit: "head0", line: 21 }), cards, version, pathOf)).toEqual({ code: { path: "a.ts", side: "RIGHT", start: 21, end: 21 } });
    expect(threadPlace(thread({ kind: "code", path: "a.ts", commit: "older", line: 21 }), cards, version, pathOf)).toBeUndefined();
  });
  it("reads a diff view's line anchor back as code on its side, head by default, by the file's path", () => {
    expect(threadPlace(thread({ kind: "diff-line", fileKey: "a-ts", line: 21 }), cards, version, pathOf)).toEqual({ code: { path: "a.ts", side: "RIGHT", start: 21, end: 21 } });
    expect(threadPlace(thread({ kind: "diff-line", fileKey: "a-ts", line: 8, endLine: 9, side: "LEFT" }), cards, version, pathOf)).toEqual({ code: { path: "a.ts", side: "LEFT", start: 8, end: 9 } });
    expect(threadPlace(thread({ kind: "diff-line", fileKey: "gone", line: 1 }), cards, version, pathOf)).toBeUndefined();
  });
});

describe("coversCode", () => {
  const shown = [{ path: "a.ts", side: "RIGHT" as const, start: 10, end: 20 }];
  it("is true when a location on the same file and side holds every line", () => {
    expect(coversCode(shown, { path: "a.ts", side: "RIGHT", start: 12, end: 20 })).toBe(true);
  });
  it("is false for lines past a location's ends, another side or another file", () => {
    expect(coversCode(shown, { path: "a.ts", side: "RIGHT", start: 18, end: 21 })).toBe(false);
    expect(coversCode(shown, { path: "a.ts", side: "LEFT", start: 12, end: 12 })).toBe(false);
    expect(coversCode(shown, { path: "b.ts", side: "RIGHT", start: 12, end: 12 })).toBe(false);
  });
});

describe("diffShowsLine", () => {
  const files = [{ path: "a.ts", hunks: [{ lines: [{ oldLine: 4, newLine: 4 }, { oldLine: 5 }, { newLine: 5 }] }] }] as unknown as ReviewFile[];
  it("finds changed and context lines on their side", () => {
    expect(diffShowsLine(files, "a.ts", "RIGHT", 4)).toBe(true);
    expect(diffShowsLine(files, "a.ts", "LEFT", 5)).toBe(true);
    expect(diffShowsLine(files, "a.ts", "RIGHT", 5)).toBe(true);
  });
  it("is false for lines outside every hunk and files not in the diff", () => {
    expect(diffShowsLine(files, "a.ts", "RIGHT", 40)).toBe(false);
    expect(diffShowsLine(files, "b.ts", "RIGHT", 4)).toBe(false);
  });
});
