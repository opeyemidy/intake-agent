import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { z } from "zod";
import { resolveDate } from "./dates.js";
import type { Slot, Store } from "./store.js";

export interface RunContext {
  store: Store;
  now: DateTime;
  /** Idempotency key for the inbound message; a retry must not double-book. */
  messageId: string;
  /** Slot ids returned by find_slots during this run. Booking is limited to these. */
  offered: Map<string, Slot>;
  actions: string[];
}

const strictObject = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const toolDefs: Anthropic.Tool[] = [
  {
    name: "resolve_date",
    description:
      "Convert the customer's date phrase (e.g. 'tomorrow', 'next friday', '2026-11-20') into an ISO date in the business time zone. Always use this instead of computing dates yourself. Returns an error if the phrase is ambiguous; then ask the customer.",
    strict: true,
    input_schema: strictObject({ expression: { type: "string" } }, ["expression"]),
  },
  {
    name: "find_slots",
    description: "List free call slots on an ISO date. Only slots returned here can be booked.",
    strict: true,
    input_schema: strictObject(
      { date: { type: "string", description: "YYYY-MM-DD" }, duration_minutes: { type: "integer", enum: [30, 60] } },
      ["date", "duration_minutes"],
    ),
  },
  {
    name: "upsert_contact",
    description: "Create or update the CRM contact for this enquiry.",
    strict: true,
    input_schema: strictObject(
      {
        email: { type: "string" },
        name: { type: "string" },
        company: { type: ["string", "null"] },
        need: { type: ["string", "null"] },
      },
      ["email", "name", "company", "need"],
    ),
  },
  {
    name: "book_slot",
    description: "Book a slot id previously returned by find_slots for the contact's email.",
    strict: true,
    input_schema: strictObject({ slot_id: { type: "string" }, email: { type: "string" } }, ["slot_id", "email"]),
  },
  {
    name: "handoff_to_human",
    description:
      "Escalate to staff. Required for refunds, payments, cancellations, complaints, or whenever you are unsure.",
    strict: true,
    input_schema: strictObject(
      { reason: { type: "string", enum: ["money", "cancellation", "complaint", "unclear", "other"] }, summary: { type: "string" } },
      ["reason", "summary"],
    ),
  },
];

const schemas = {
  resolve_date: z.object({ expression: z.string().min(1) }),
  find_slots: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), duration_minutes: z.union([z.literal(30), z.literal(60)]) }),
  upsert_contact: z.object({ email: z.email(), name: z.string().min(1), company: z.string().nullable(), need: z.string().nullable() }),
  book_slot: z.object({ slot_id: z.string(), email: z.email() }),
  handoff_to_human: z.object({ reason: z.enum(["money", "cancellation", "complaint", "unclear", "other"]), summary: z.string() }),
};

export type ToolName = keyof typeof schemas;

export class ToolError extends Error {}

/** Validate input in code (never trust the model's arguments) and run the tool. */
export function runTool(name: string, rawInput: unknown, ctx: RunContext): unknown {
  if (!(name in schemas)) throw new ToolError(`unknown tool ${name}`);
  const parsed = schemas[name as ToolName].safeParse(rawInput);
  if (!parsed.success) throw new ToolError(`invalid input: ${parsed.error.message}`);
  const input = parsed.data as any;
  const { store } = ctx;

  switch (name as ToolName) {
    case "resolve_date": {
      const date = resolveDate(input.expression, ctx.now);
      if (!date) throw new ToolError(`could not resolve "${input.expression}"; ask the customer for a specific date`);
      return { date, weekday: DateTime.fromISO(date).toFormat("cccc"), time_zone: store.zone };
    }
    case "find_slots": {
      if (input.date < ctx.now.toISODate()!) throw new ToolError("date is in the past");
      const slots = store.freeSlots(input.date, input.duration_minutes).slice(0, 6);
      for (const s of slots) ctx.offered.set(s.id, s);
      return { slots };
    }
    case "upsert_contact": {
      store.contacts.set(input.email.toLowerCase(), { ...input, email: input.email.toLowerCase() });
      ctx.actions.push("upsert_contact");
      return { ok: true };
    }
    case "book_slot": {
      const existing = store.bookings.find((b) => b.idempotencyKey === ctx.messageId);
      if (existing) return { booking_id: existing.id, duplicate: true };
      const slot = ctx.offered.get(input.slot_id);
      if (!slot) throw new ToolError("slot_id was not returned by find_slots in this conversation");
      if (!store.contacts.has(input.email.toLowerCase())) throw new ToolError("upsert_contact first");
      // re-check availability at write time
      const day = DateTime.fromISO(slot.start, { zone: store.zone }).toISODate()!;
      const minutes = DateTime.fromISO(slot.end).diff(DateTime.fromISO(slot.start), "minutes").minutes;
      if (!store.freeSlots(day, minutes).some((s) => s.id === slot.id)) throw new ToolError("slot no longer free");
      const booking = { id: `bk_${store.bookings.length + 1}`, slotId: slot.id, contactEmail: input.email.toLowerCase(), idempotencyKey: ctx.messageId };
      store.bookings.push(booking);
      ctx.actions.push("book_slot");
      return { booking_id: booking.id, start: slot.start };
    }
    case "handoff_to_human": {
      store.handoffs.push(input);
      ctx.actions.push(`handoff:${input.reason}`);
      return { ok: true, note: "Staff notified. Tell the customer someone will reply." };
    }
  }
}
