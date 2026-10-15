import { liveAllowed, liveCooldown, _resetLiveGate, LIVE_COOLDOWN_MS } from "@/lib/live-search-gate";

beforeEach(() => _resetLiveGate());

describe("liveAllowed", () => {
  const p = (qs: string) => new URLSearchParams(qs);
  it("a first page is index-only unless it says live=1", () => {
    expect(liveAllowed(p("q=x"), "")).toBe(false);
    expect(liveAllowed(p("q=x&live=0"), "")).toBe(false);
    expect(liveAllowed(p("q=x&live=true"), "")).toBe(false);
    expect(liveAllowed(p("q=x&live=1"), "")).toBe(true);
  });
  it("a pageToken request ('load more') is a deliberate tap and may bill", () => {
    expect(liveAllowed(p("q=x"), "CDIQAA")).toBe(true);
  });
});

describe("liveCooldown", () => {
  it("allows one billed attempt per LIVE_COOLDOWN_MS per uuid", () => {
    expect(liveCooldown("u1", 0).ok).toBe(true);
    const second = liveCooldown("u1", 500);
    expect(second).toEqual({ ok: false, retryAfterMs: LIVE_COOLDOWN_MS - 500 });
    expect(liveCooldown("u1", LIVE_COOLDOWN_MS - 1).ok).toBe(false);
    expect(liveCooldown("u1", LIVE_COOLDOWN_MS).ok).toBe(true);
  });
  it("a denied attempt does not extend the lockout", () => {
    liveCooldown("u1", 0);
    liveCooldown("u1", 1500); // denied
    expect(liveCooldown("u1", LIVE_COOLDOWN_MS).ok).toBe(true);
  });
  it("is independent per uuid", () => {
    expect(liveCooldown("u1", 0).ok).toBe(true);
    expect(liveCooldown("u2", 10).ok).toBe(true);
  });
  it("keeps its map bounded under uuid rotation", () => {
    for (let i = 0; i < 5000; i++) liveCooldown(`rot${i}`, 0);
    // the oldest were evicted, so the first rotator is allowed again
    expect(liveCooldown("rot0", 1).ok).toBe(true);
    // a recent one is still held
    expect(liveCooldown("rot4999", 1).ok).toBe(false);
  });
});
