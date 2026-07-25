import type { ToolKind } from "../../model/events.js";

const PATTERNS: readonly (readonly [RegExp, ToolKind])[] = [
  [/^(apply[_-]?patch|patch)$/i, "write"],
  [/(write|edit|create[_-]?file|delete)/i, "write"],
  [/^(shell|bash|exec|local[_-]?shell|run[_-]?command|terminal)$/i, "execute"],
  [/(read|cat|view|get[_-]?file|open[_-]?file)/i, "read"],
  [/(web[_-]?search|browser|fetch|http)/i, "network"],
  [/(search|grep|find|glob)/i, "search"],
  [/(subagent|delegate|task)/i, "delegate"],
];

/**
 * Best-effort classification from a Codex tool name.
 *
 * Codex does not publish a closed enum of tool names (built-ins like
 * `apply_patch` and `shell` are documented; MCP tool names are arbitrary), so
 * this is a heuristic rather than a lookup table. Unmatched names fall back to
 * `other`, never `unknown`, because the tool name itself is always known.
 */
export const classifyCodexToolKind = (toolName: string): ToolKind => {
  for (const [pattern, kind] of PATTERNS) {
    if (pattern.test(toolName)) {
      return kind;
    }
  }
  return "other";
};
