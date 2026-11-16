/**
 * Graph mode (prototype): where a thread is, in unvibed's terms (a Place) and in Unvibe's (an anchor). A node's
 * text is its card's block of the same id; a location's text is the block with the location's id; code is lines on
 * one side, at the merge base for the base side and at the head for the head side.
 */
import type { ActionAnchor, Thread } from "@unvibe/shared";
import type { Place } from "@unvibed/viewer";
import { splitAnchorBlockId } from "../guide/guideUtils.js";

type Version = { mergeBaseSha: string; headSha: string };

export function placeToAnchor(at: Place, version: Version): ActionAnchor {
  if ("code" in at) {
    const { path, side, start, end } = at.code;
    return { where: "code", path, commit: side === "LEFT" ? version.mergeBaseSha : version.headSha, line: start, ...(end !== start ? { endLine: end } : {}) };
  }
  return { where: "block", blockId: `${at.node}#${"location" in at ? at.location : at.node}` };
}

/**
 * A thread's place in the graph; undefined for a thread elsewhere in the review (another page, another commit). A
 * thread from the diff view is on a diff file's line, so pathOf gives that file's path.
 */
export function threadPlace(thread: Thread, graphCards: ReadonlySet<string>, version: Version, pathOf: (fileKey: string) => string | undefined): Place | undefined {
  const host = thread.anchor.host;
  if (host.kind === "diff-line") {
    const path = pathOf(host.fileKey);
    if (!path) return undefined;
    return { code: { path, side: host.side ?? "RIGHT", start: host.line, end: host.endLine ?? host.line } };
  }
  if (host.kind === "code") {
    if (host.commit !== version.mergeBaseSha && host.commit !== version.headSha) return undefined;
    const side = host.commit === version.headSha ? "RIGHT" : "LEFT";
    return { code: { path: host.path, side, start: host.line, end: host.endLine ?? host.line } };
  }
  if (host.kind !== "block") return undefined;
  const { cardId, block } = splitAnchorBlockId(host.blockId);
  if (!cardId || !graphCards.has(cardId)) return undefined;
  return block === cardId ? { node: cardId } : { node: cardId, location: block };
}
