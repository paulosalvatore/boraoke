/**
 * Room data retention config unit tests (TICKET-91).
 *
 * Proves the MECHANISM and, above all, its zero-behavior-change default: with
 * ROOM_RETENTION_DAYS unset the write-path helpers must produce a plain SET
 * (no options), so the change is inert until a Tech-Lead picks a window.
 */
import {
  roomRetentionDays,
  roomRetentionSeconds,
  roomCreateSetOptions,
  roomUpdateSetOptions,
} from "@/lib/retention";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function setDays(v: string | undefined) {
  if (v === undefined) delete process.env.ROOM_RETENTION_DAYS;
  else process.env.ROOM_RETENTION_DAYS = v;
}

describe("retention OFF by default (zero behavior change)", () => {
  it("returns no window when unset", () => {
    setDays(undefined);
    expect(roomRetentionDays()).toBeNull();
    expect(roomRetentionSeconds()).toBeNull();
  });

  it("write-path helpers produce a plain SET when unset", () => {
    setDays(undefined);
    // undefined ⇒ redis.set(key, value, undefined) == a bare SET, no expiry.
    expect(roomCreateSetOptions()).toBeUndefined();
    expect(roomUpdateSetOptions()).toBeUndefined();
  });

  it.each(["", "  ", "0", "-5", "abc", "NaN"])(
    "treats %p as OFF (no window)",
    (v) => {
      setDays(v);
      expect(roomRetentionDays()).toBeNull();
      expect(roomRetentionSeconds()).toBeNull();
      expect(roomCreateSetOptions()).toBeUndefined();
      expect(roomUpdateSetOptions()).toBeUndefined();
    },
  );
});

describe("retention ON when a positive window is configured", () => {
  it("converts days to whole seconds", () => {
    setDays("30");
    expect(roomRetentionDays()).toBe(30);
    expect(roomRetentionSeconds()).toBe(30 * 24 * 60 * 60); // 2_592_000
  });

  it("emits { ex } on create and { keepTtl } on update", () => {
    setDays("7");
    expect(roomCreateSetOptions()).toEqual({ ex: 7 * 24 * 60 * 60 });
    // Update preserves the create-time TTL rather than resetting it.
    expect(roomUpdateSetOptions()).toEqual({ keepTtl: true });
  });

  it("floors a fractional day window to an integer second", () => {
    setDays("0.5");
    expect(roomRetentionSeconds()).toBe(Math.floor(0.5 * 24 * 60 * 60)); // 43_200
    expect(roomCreateSetOptions()).toEqual({ ex: 43_200 });
  });

  it("reads the env at call time, not module load", () => {
    setDays(undefined);
    expect(roomCreateSetOptions()).toBeUndefined();
    setDays("1");
    expect(roomCreateSetOptions()).toEqual({ ex: 24 * 60 * 60 });
  });
});
