import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { handleEnquiry } from "../src/agent.js";
import { Store } from "../src/store.js";
import { scripted } from "./scripted.js";

const now = DateTime.fromISO("2026-11-04T10:00", { zone: "Africa/Lagos" });
const enquiry = { id: "msg_1", from: "ada@acme.test", body: "Hi, we'd like a call next Friday morning about a website rebuild. - Ada, Acme" };

const happyPath = () =>
  scripted([
    [{ tool: "upsert_contact", input: () => ({ email: "ada@acme.test", name: "Ada", company: "Acme", need: "website rebuild" }) }],
    [{ tool: "resolve_date", input: () => ({ expression: "next friday" }) }],
    [{ tool: "find_slots", input: ([r]) => ({ date: r.date, duration_minutes: 30 }) }],
    [{ tool: "book_slot", input: ([r]) => ({ slot_id: r.slots[0].id, email: "ada@acme.test" }) }],
    [{ text: "Booked for Friday 13 Nov at 09:00 WAT.\nINTENT: new_lead" }],
  ]);

describe("handleEnquiry", () => {
  it("books one of the offered slots", async () => {
    const store = new Store("Africa/Lagos");
    const r = await handleEnquiry(happyPath(), store, enquiry, { now });
    expect(r.intent).toBe("new_lead");
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0].slotId.startsWith("2026-11-13T08:00:00.000Z")).toBe(true);
  });

  it("is idempotent when the same message is processed twice", async () => {
    const store = new Store("Africa/Lagos");
    await handleEnquiry(happyPath(), store, enquiry, { now });
    const r = await handleEnquiry(happyPath(), store, enquiry, { now });
    expect(store.bookings).toHaveLength(1);
    expect(r.toolCalls.find((c) => c.name === "book_slot")?.error).toBeUndefined();
  });

  it("refuses a slot the calendar never offered", async () => {
    const store = new Store("Africa/Lagos");
    const model = scripted([
      [{ tool: "upsert_contact", input: () => ({ email: "ada@acme.test", name: "Ada", company: null, need: null }) }],
      [{ tool: "book_slot", input: () => ({ slot_id: "2026-11-13T07:00:00.000Z/2026-11-13T07:30:00.000Z", email: "ada@acme.test" }) }],
      [{ text: "Sorry, let me check availability.\nINTENT: new_lead" }],
    ]);
    const r = await handleEnquiry(model, store, enquiry, { now });
    expect(store.bookings).toHaveLength(0);
    expect(r.toolCalls[1].error).toMatch(/not returned by find_slots/);
  });

  it("skips busy time", async () => {
    const store = new Store("Africa/Lagos", [{ start: "2026-11-13T09:00+01:00", end: "2026-11-13T10:00+01:00" }]);
    const r = await handleEnquiry(happyPath(), store, enquiry, { now });
    expect(r.actions).toContain("book_slot");
    expect(store.bookings[0].slotId.startsWith("2026-11-13T09:00:00.000Z")).toBe(true); // 10:00 WAT
  });

  it("stops and hands off when the tool budget runs out", async () => {
    const loop = scripted(Array.from({ length: 20 }, () => [{ tool: "resolve_date", input: () => ({ expression: "today" }) }]));
    const store = new Store("Africa/Lagos");
    const r = await handleEnquiry(loop, store, enquiry, { now, maxToolCalls: 3 });
    expect(r.stoppedBy).toBe("tool_budget");
    expect(store.handoffs).toHaveLength(1);
  });

  it("rejects malformed tool input in code", async () => {
    const store = new Store("Africa/Lagos");
    const model = scripted([
      [{ tool: "find_slots", input: () => ({ date: "next week", duration_minutes: 45 }) }],
      [{ text: "Which day works?\nINTENT: new_lead" }],
    ]);
    const r = await handleEnquiry(model, store, enquiry, { now });
    expect(r.toolCalls[0].error).toMatch(/invalid input/);
  });
});
