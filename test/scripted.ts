import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "../src/agent.js";

type Step = { tool: string; input: (lastResults: any[]) => unknown } | { text: string };

/** A fake model that plays a fixed script, reading earlier tool results where needed. */
export function scripted(steps: Step[][]): ModelClient & { calls: number } {
  let i = 0;
  const client = {
    calls: 0,
    async create({ messages }: { messages: Anthropic.Beta.BetaMessageParam[] }) {
      client.calls++;
      const last = messages[messages.length - 1];
      const lastResults = Array.isArray(last.content)
        ? (last.content as any[]).filter((b) => b.type === "tool_result").map((b) => (b.is_error ? { error: b.content } : JSON.parse(b.content)))
        : [];
      const turn = steps[i++] ?? [{ text: "INTENT: unclear" }];
      const content = turn.map((s, j) =>
        "text" in s
          ? { type: "text" as const, text: s.text, citations: null }
          : { type: "tool_use" as const, id: `tu_${i}_${j}`, name: s.tool, input: s.input(lastResults), caller: { type: "direct" as const } },
      );
      return { content: content as any, stop_reason: content.some((c) => c.type === "tool_use") ? ("tool_use" as const) : ("end_turn" as const) };
    },
  };
  return client;
}
