import { DateTime } from "luxon";

export interface Slot { id: string; start: string; end: string }
export interface Booking { id: string; slotId: string; contactEmail: string; idempotencyKey: string }
export interface Contact { email: string; name: string; company?: string; need?: string }

/** In-memory calendar and CRM. Swap for Google Calendar / Postgres adapters. */
export class Store {
  bookings: Booking[] = [];
  contacts = new Map<string, Contact>();
  handoffs: { reason: string; summary: string }[] = [];

  constructor(
    readonly zone: string,
    /** busy intervals as ISO strings */
    readonly busy: { start: string; end: string }[] = [],
    readonly hours = { open: 9, close: 17 },
  ) {}

  freeSlots(isoDate: string, durationMin: number): Slot[] {
    const day = DateTime.fromISO(isoDate, { zone: this.zone });
    if (day.weekday > 5) return [];
    const out: Slot[] = [];
    let t = day.set({ hour: this.hours.open });
    const close = day.set({ hour: this.hours.close });
    while (t.plus({ minutes: durationMin }) <= close) {
      const end = t.plus({ minutes: durationMin });
      const clash =
        this.busy.some((b) => DateTime.fromISO(b.start) < end && DateTime.fromISO(b.end) > t) ||
        this.bookings.some((b) => b.slotId === slotId(t, end));
      if (!clash) out.push({ id: slotId(t, end), start: t.toISO()!, end: end.toISO()! });
      t = t.plus({ minutes: 30 });
    }
    return out;
  }
}

export const slotId = (s: DateTime, e: DateTime) => `${s.toUTC().toISO()}/${e.toUTC().toISO()}`;
