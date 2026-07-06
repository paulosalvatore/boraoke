import { resolvePoweredByFooter } from "@/components/tv/config";

describe("resolvePoweredByFooter (POWERED_BY_FOOTER flag — TICKET-18 AC5)", () => {
  it("defaults ON when unset", () => {
    expect(resolvePoweredByFooter(undefined)).toBe(true);
    expect(resolvePoweredByFooter(null)).toBe(true);
    expect(resolvePoweredByFooter("")).toBe(true);
    expect(resolvePoweredByFooter("   ")).toBe(true);
  });

  it("stays ON for affirmative / unknown values", () => {
    expect(resolvePoweredByFooter("1")).toBe(true);
    expect(resolvePoweredByFooter("true")).toBe(true);
    expect(resolvePoweredByFooter("on")).toBe(true);
    expect(resolvePoweredByFooter("yes")).toBe(true);
    expect(resolvePoweredByFooter("banana")).toBe(true); // unknown → safe default
  });

  it("turns OFF only for explicit opt-out values (case/whitespace-insensitive)", () => {
    expect(resolvePoweredByFooter("0")).toBe(false);
    expect(resolvePoweredByFooter("false")).toBe(false);
    expect(resolvePoweredByFooter("off")).toBe(false);
    expect(resolvePoweredByFooter("no")).toBe(false);
    expect(resolvePoweredByFooter("FALSE")).toBe(false);
    expect(resolvePoweredByFooter("  Off  ")).toBe(false);
  });
});
