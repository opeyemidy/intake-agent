import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { resolveDate } from "../src/dates.js";

// Wednesday 4 Nov 2026, 10:00 Lagos
const now = DateTime.fromISO("2026-11-04T10:00", { zone: "Africa/Lagos" });

describe("resolveDate", () => {
  it.each([
    ["today", "2026-11-04"],
    ["Tomorrow", "2026-11-05"],
    ["friday", "2026-11-06"],
    ["this friday", "2026-11-06"],
    ["next friday", "2026-11-13"],
    ["wednesday", "2026-11-04"],
    ["next monday", "2026-11-09"],
    ["2026-11-20", "2026-11-20"],
  ])("%s -> %s", (expr, want) => expect(resolveDate(expr, now)).toBe(want));

  it("rejects past and ambiguous dates", () => {
    expect(resolveDate("2026-10-01", now)).toBeNull();
    expect(resolveDate("sometime soon", now)).toBeNull();
    expect(resolveDate("the 5th", now)).toBeNull();
  });

  it("uses the business zone, not UTC", () => {
    // 23:30 UTC on Tuesday is already Wednesday in Lagos (UTC+1)
    const late = DateTime.fromISO("2026-11-03T23:30Z").setZone("Africa/Lagos");
    expect(resolveDate("today", late)).toBe("2026-11-04");
  });
});
