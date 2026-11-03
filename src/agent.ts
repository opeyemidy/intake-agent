import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import type { Store } from "./store.js";
import { runTool, ToolError, toolDefs, type RunContext } from "./tools.js";

export const MODEL = "claude-opus-5-5";

/** The subset of the Messages API the agent needs; tests inject a scripted fake. */
export interface ModelClient {
  create(params: {
    system: string;
    messages: Anthropic.Beta.BetaMessageParam[];
    tools: Anthropic.Tool[];
  }): Promise<Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason">>;
}

export function anthropicClient(client = new Anthropic()): ModelClient {
  return {
    create: ({ system, messages, tools }) =>
      client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        // Server-side fallback if the request is declined by a safety classifier.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        tools,
        tool_choice: { type: "auto" },
        messages,
      }),
  };
}

export interface AgentResult {
  reply: string;
  actions: string[];
  toolCalls: { name: string; input: unknown; error?: string }[];
  stoppedBy: "end_turn" | "tool_budget" | "refusal" | "max_tokens";
}

const systemPrompt = (now: DateTime, zone: string) => `You are the intake assistant for a professional-services firm.
For each inbound enquiry:
1. Decide the intent: new_lead, reschedule, support, or spam.
2. For a new lead who wants a call: upsert_contact, then resolve_date for any date they mention, then find_slots, then book_slot with one of the returned slot ids (the earliest that matches their stated preference), then write a short reply confirming the time in ${zone}.
3. Anything about money, refunds, cancellations or complaints goes to handoff_to_human. So does anything you are unsure about.
4. Spam: reply with an empty string and take no action.
Never state a date or time that a tool did not return. If a date is ambiguous, ask instead of guessing.
Current time: ${now.toISO()} (${zone}).
End your final message with a line "INTENT: <intent>".`;

export async function handleEnquiry(
  model: ModelClient,
  store: Store,
  enquiry: { id: string; from: string; body: string },
  opts: { now?: DateTime; maxToolCalls?: number } = {},
): Promise<AgentResult & { intent?: string }> {
  const now = (opts.now ?? DateTime.now()).setZone(store.zone);
  const maxToolCalls = opts.maxToolCalls ?? 8;
  const ctx: RunContext = { store, now, messageId: enquiry.id, offered: new Map(), actions: [] };
  const toolCalls: AgentResult["toolCalls"] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `From: ${enquiry.from}\n\n${enquiry.body}` },
  ];
  const system = systemPrompt(now, store.zone);

  for (;;) {
    const res = await model.create({ system, messages, tools: toolDefs });
    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });

    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      return finish(res.stop_reason);
    }
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) return finish("end_turn", textOf(res.content));

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      if (toolCalls.length >= maxToolCalls) {
        store.handoffs.push({ reason: "unclear", summary: "tool budget exhausted" });
        ctx.actions.push("handoff:unclear");
        return finish("tool_budget");
      }
      try {
        const out = runTool(use.name, use.input, ctx);
        toolCalls.push({ name: use.name, input: use.input });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out) });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        toolCalls.push({ name: use.name, input: use.input, error: err.message });
        results.push({ type: "tool_result", tool_use_id: use.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  function finish(stoppedBy: AgentResult["stoppedBy"], text = "") {
    const intent = /INTENT:\s*(\w+)/.exec(text)?.[1];
    const reply = text.replace(/\n?INTENT:.*$/s, "").trim();
    return { reply, actions: ctx.actions, toolCalls, stoppedBy, intent };
  }
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]) {
  return content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
}
