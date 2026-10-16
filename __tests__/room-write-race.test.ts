/**
 * TICKET-127 — every pair of room-record writers, in the worst order.
 *
 * Each room mutation reads the record, changes it, and writes it back. The
 * dangerous order for any two writers A and B is: A reads, B commits, A writes.
 * If A's write is accepted, it carries A's pre-B snapshot and erases B. These
 * tests force exactly that order, deterministically and with no timers:
 *
 *   1. start A and HOLD its first `roomBackend.update` call (A has read);
 *   2. run B to completion (its writes pass straight through);
 *   3. release A's held write and let A finish (any retry passes through).
 *
 * Then they check each writer's own effect and the global owner invariant. With
 * a plain whole-record SET (the pre-fix backend), A's held write lands and B's
 * effect is gone. With the compare-and-set backend, A's held write is refused
 * because B moved the record's revision, and A recomputes from the record that
 * includes B.
 *
 * Deliberately written against the public room API only, so the same file runs
 * against the pre-fix `lib/` (the prove-your-test-can-fail reverse check).
 *
 * Writers: login mint, owner mint (creation, revoke fallback), logout of one staff
 * device, "sign out other devices" (owner), and the three host settings.
 */
import { PAIRS, WRITERS, runPair } from "./helpers/room-writers";

afterEach(() => jest.restoreAllMocks());

describe("TICKET-127: A reads, B commits, A writes — B's effect survives, for every pair", () => {
  it.each(PAIRS)("stale %s, interleaved %s", (a, b) => runPair(a, b));

  it("covers every ordered writer pair except the documented skips", () => {
    const n = Object.keys(WRITERS).length;
    expect(PAIRS.length).toBe(n * n - 4);
  });
});
