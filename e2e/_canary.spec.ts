import { test, expect } from "@playwright/test";

// TICKET-116 — RUN-TRIAGE CANARY. This is deliberately NOT a product test.
//
// Moving the suite onto a production build is a change whose evidence is a
// DISTRIBUTION over repeated cold runs, not a single green. That evidence is
// only readable if a failed run can be classified: did the PRODUCT fail, or did
// the run itself fail (a Playwright worker that died, an OOM, a machine so
// contended the harness misbehaved)? Without a control those two look alike in
// the report, and the honest response to an unclassifiable run is to VOID it —
// which is only defensible if voiding is driven by a signal rather than by
// whichever reading is more convenient.
//
// So: assertions over constants and the harness's own primitives, touching no
// route, no store, no server and no product module. They cannot fail for a
// product reason. If this file is red, the run says nothing about the product
// and is voided, not triaged.
//
// It runs first (`_` sorts ahead of the lowercase spec filenames) so a broken
// runner is visible before minutes of suite time are spent.
test.describe("run-triage canary (not a product test)", () => {
  test("the runner evaluates constants correctly", () => {
    expect(2 + 2).toBe(4);
    expect("boraoke".toUpperCase()).toBe("BORAOKE");
    expect([3, 1, 2].sort()).toEqual([1, 2, 3]);
  });

  test("the runner's async primitives complete", async () => {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    await expect(Promise.resolve("ok")).resolves.toBe("ok");
  });
});
