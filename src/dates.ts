import { DateTime } from "luxon";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * Resolve a date expression to an ISO date (YYYY-MM-DD) in the business time zone.
 * The model never does date arithmetic: it passes the user's phrase here.
 * Returns null when the phrase is ambiguous or unsupported, so the agent must ask.
 */
export function resolveDate(expression: string, now: DateTime): string | null {
  const e = expression.trim().toLowerCase().replace(/\s+/g, " ");
  const today = now.startOf("day");

  if (e === "today") return today.toISODate();
  if (e === "tomorrow") return today.plus({ days: 1 }).toISODate();

  const iso = DateTime.fromISO(e, { zone: now.zone });
  if (/^\d{4}-\d{2}-\d{2}$/.test(e) && iso.isValid) {
    return iso < today ? null : iso.toISODate();
  }

  // "friday" / "this friday": the next occurrence, today included.
  // "next friday": the Friday of next calendar week (Mon-Sun). This is the
  // reading most of our customers meant; the convention lives here, not in a prompt.
  const m = /^(this |next )?([a-z]+)$/.exec(e);
  if (m && WEEKDAYS.includes(m[2])) {
    const target = WEEKDAYS.indexOf(m[2]) + 1; // luxon: Monday = 1
    if (m[1] === "next ") {
      const nextMonday = today.plus({ days: 8 - today.weekday });
      return nextMonday.plus({ days: target - 1 }).toISODate();
    }
    return today.plus({ days: (target - today.weekday + 7) % 7 }).toISODate();
  }
  return null;
}
