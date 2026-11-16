/**
 * Graph mode (prototype): an opt-in AI reviewer that rates how risky each graph location's lines are. Ratings are kept
 * apart from the graph, by location (path, side and hash), so a rated location keeps its rating while its code is
 * unchanged, and the graph the writer made is never touched; the page lays them over the graph it shows.
 */
import type { Graph, Location, Risk } from "../../../../../../unvibed-graph/shared/graph.ts";
import type { At } from "./unvibed-writer.js";

/** What a review keeps for risk: whether the reviewer turned it on, and every rating, by riskKey. */
export type RiskFile = { on: boolean; byKey: Record<string, Risk> };

/** Where a rating belongs: the same lines in the same file and side keep it, wherever they move. */
export function riskKey(l: Pick<Location, "path" | "side" | "hash">): string {
  return `${l.path}|${l.side}|${l.hash}`;
}

/** The ids of the graph's locations that have no rating yet. */
export function unrated(graph: Graph, byKey: Record<string, Risk>): string[] {
  return graph.nodes.flatMap((n) => n.code).filter((l) => !byKey[riskKey(l)]).map((l) => l.id);
}

/** Each location's rating, by location id, for the page to lay over the graph. */
export function risksById(graph: Graph, byKey: Record<string, Risk>): Record<string, Risk> {
  const risks: Record<string, Risk> = {};
  for (const l of graph.nodes.flatMap((n) => n.code)) {
    const risk = byKey[riskKey(l)];
    if (risk) risks[l.id] = risk;
  }
  return risks;
}

const LEVELS = new Set(["low", "medium", "high"]);

/**
 * Reads rate_risk's input against the graph: the ratings to keep, by riskKey, and what was wrong with the rest, so the
 * agent can fix them.
 */
export function readRatings(input: unknown, graph: Graph): { ratings: Record<string, Risk>; problems: string[] } {
  if (!Array.isArray(input)) return { ratings: {}, problems: ["risks must be a list of { location, level, reason }."] };
  const locations = new Map(graph.nodes.flatMap((n) => n.code).map((l) => [l.id, l]));
  const ratings: Record<string, Risk> = {};
  const problems: string[] = [];
  for (const item of input as { location?: unknown; level?: unknown; reason?: unknown }[]) {
    const location = locations.get(String(item?.location ?? ""));
    if (!location) {
      problems.push(`${String(item?.location)} is not a location id in the graph.`);
      continue;
    }
    if (!LEVELS.has(String(item.level))) {
      problems.push(`${location.id}: level must be low, medium or high.`);
      continue;
    }
    ratings[riskKey(location)] = { level: item.level as Risk["level"], reason: String(item.reason ?? "") };
  }
  return { ratings, problems };
}

/** What the risk-rating session is asked first. */
export function riskPrompt(graph: Graph, at: At, toRate: string[]): string {
  return [
    "# Rate the risk of this change's code",
    "",
    `The reviewer asked for an AI reviewer's view of how risky each part of this change is. The change is git diff ${at.base} ${at.head} in this repo, whose head is checked out. Below is the review's graph: nodes explain the change, and each location is a range of changed lines. Read the code with get_code, Read and Grep.`,
    "",
    "For each location to rate, read its lines in the diff and the code they touch, then rate them:",
    "",
    "- high: likely to be wrong, or to break something that matters if it is: wrong results, lost data, a crash, a security hole, or a contract other code relies on.",
    "- medium: could be wrong in a case that's easy to miss, or changes behaviour other code or people depend on.",
    "- low: hard to get wrong, or harmless if wrong, such as a rename, a comment or a test that only adds checks.",
    "",
    "The reason is one or two plain sentences saying what could go wrong and in which case, or why little can. Rate what the lines do, not how well the graph explains them.",
    "",
    "Send your ratings with rate_risk, in as many calls as you like. You're done when every location is rated.",
    "",
    `Locations to rate: ${toRate.join(", ")}`,
    "",
    "```json",
    JSON.stringify(graph, null, 2),
    "```",
  ].join("\n");
}
