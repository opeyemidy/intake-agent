/**
 * Runs the golden set against the live model and scores each case with deterministic checks.
 * Run before any prompt or model change:  npm run eval
 * Costs real API usage (8 cases, a few tool turns each).
 */
import { DateTime } from "luxon";
import { readFileSync } from "node:fs";
import { anthropicClient, handleEnquiry } from "../src/agent.js";
import { Store } from "../src/store.js";

interface Case {
  id: string; from: string; body: string;
  expect: { intent?: string; booked: boolean; bookedDate?: string; beforeHour?: number; afterHour?: number; handoff?: string; noActions?: boolean; asksForDate?: boolean };
}

const cases: Case[] = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
const now = DateTime.fromISO("2026-11-04T10:00", { zone: "Africa/Lagos" }); // fixed clock: Wednesday
const model = anthropicClient();
let passed = 0;

for (const c of cases) {
  const store = new Store("Africa/Lagos", [{ start: "2026-11-13T09:00+01:00", end: "2026-11-13T09:30+01:00" }]);
  const r = await handleEnquiry(model, store, { id: c.id, from: c.from, body: c.body }, { now });
  const fails: string[] = [];
  const e = c.expect;
  const b = store.bookings[0];
  const start = b ? DateTime.fromISO(b.slotId.split("/")[0]).setZone(store.zone) : undefined;

  if (e.intent && r.intent !== e.intent) fails.push(`intent ${r.intent} != ${e.intent}`);
  if (e.booked !== Boolean(b)) fails.push(`booked=${Boolean(b)}`);
  if (e.bookedDate && start?.toISODate() !== e.bookedDate) fails.push(`date ${start?.toISODate()} != ${e.bookedDate}`);
  if (e.beforeHour && start && start.hour >= e.beforeHour) fails.push(`hour ${start.hour} not before ${e.beforeHour}`);
  if (e.afterHour && start && start.hour < e.afterHour) fails.push(`hour ${start.hour} not after ${e.afterHour}`);
  if (e.handoff && !r.actions.includes(`handoff:${e.handoff}`)) fails.push(`no handoff:${e.handoff}`);
  if (e.noActions && r.actions.length) fails.push(`unexpected actions ${r.actions}`);
  if (e.asksForDate && !/\?/.test(r.reply)) fails.push("did not ask for a date");
  // Faithfulness: every time in the reply must be the booked time.
  if (b && start && !r.reply.includes(start.toFormat("HH:mm")) && !r.reply.includes(start.toFormat("h:mm")) && !r.reply.toLowerCase().includes(start.toFormat("ha").toLowerCase()) && !r.reply.toLowerCase().includes(start.toFormat("h a").toLowerCase()))
    fails.push("reply does not state the booked time");

  if (!fails.length) passed++;
  console.log(`${fails.length ? "FAIL" : "pass"} ${c.id} ${fails.join("; ")}`);
}
console.log(`\n${passed}/${cases.length} passed`);
process.exitCode = passed === cases.length ? 0 : 1;
