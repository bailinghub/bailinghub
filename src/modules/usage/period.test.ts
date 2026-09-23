import test from "node:test";
import assert from "node:assert/strict";
import { periodBounds } from "./period";
test("calendar month keeps original anchor after short month and weekly reset is stable", () => {
  const rule = {
    unit: "month" as const,
    anchor: Date.parse("2026-01-31T10:00:00Z"),
    timezone: "UTC",
  };
  assert.deepEqual(periodBounds(rule, Date.parse("2026-03-01T00:00:00Z")), {
    start: Date.parse("2026-02-28T10:00:00Z"),
    end: Date.parse("2026-03-31T10:00:00Z"),
  });
  assert.deepEqual(
    periodBounds({ unit: "week", anchor: 1000, timezone: "UTC" }, 604801000),
    { start: 604801000, end: 1209601000 },
  );
});
test("calendar month DST gap advances to first valid local minute", () => {
  const anchor = Date.parse("2026-02-08T07:30:00Z");
  const got = periodBounds(
    { unit: "month", anchor, timezone: "America/New_York" },
    Date.parse("2026-03-09T00:00:00Z"),
  );
  assert.equal(got?.start, Date.parse("2026-03-08T07:00:00Z"));
});
