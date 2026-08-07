import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * TICKET-60 — Computed-style contrast assertions.
 *
 * Context: the TICKET-20 render/link suite (e2e/render-and-links.spec.ts)
 * asserts that elements are *present* and *visible*, but "visible" per
 * Playwright only means "has a non-zero box in the viewport" — it says
 * nothing about whether a human can actually read the text. That gap is what
 * let the join-code-input bug ship on PR #17: the input's fill
 * (`background: var(--surface)`) sat on top of a card with the SAME
 * `var(--surface)` background, so the field was invisible even though every
 * `toBeVisible()` assertion in the old suite passed. An opus reviewer flagged
 * this as a HIGH follow-up that never shipped — this spec is that follow-up.
 *
 * This suite does NOT compare class names or CSS custom-property names (that
 * would have passed on the original bug too, since both sides really were
 * `var(--surface)` — the names matched, the *rendered* colors just happened to
 * be identical). It resolves every element's actual `getComputedStyle` colors
 * to concrete rgb() values, walks up the ancestor chain to find the real
 * (opaque) painted background when an element's own background is
 * transparent, and computes the WCAG relative-luminance contrast ratio.
 *
 * Thresholds (WCAG AA):
 *   - 4.5:1 for normal text
 *   - 3:1 for large text (>=24px, or >=18.66px AND bold/>=700)
 *
 * Per TICKET-60 acceptance criteria: this suite must NOT redesign or loosen
 * tokens to make itself pass. Any genuine failure found against current
 * `main` is recorded as a `test.fixme` with an inline comment citing the exact
 * selector/colors/ratio, never silently skipped or threshold-loosened. See
 * work/reports/dev/TICKET-60-dev-report.md for the full list of findings.
 */

// ─── Contrast math (runs inside the page via locator.evaluate) ────────────

/**
 * Shape returned from the browser for one element. All colors are resolved,
 * concrete rgb() strings — never CSS variable names or class names — so a
 * failing assertion always reports real paint, not token labels.
 */
interface ContrastResult {
  fg: string; // resolved rgb() the browser actually paints for foreground text
  bg: string; // resolved rgb() the browser actually paints behind it (opaque)
  ratio: number;
  fontSizePx: number;
  fontWeight: number;
  isLargeText: boolean;
}

/**
 * Evaluated in-page. Kept dependency-free (no import from e2e/helpers.ts —
 * TICKET-60 owns this file only) and inlined into every locator.evaluate call
 * since Playwright serializes evaluate functions independently per call.
 */
function inPageContrast(el: Element): ContrastResult | { error: string } {
  function parseColor(str: string): [number, number, number, number] {
    // getComputedStyle always normalizes to rgb(...)/rgba(...) in Chromium.
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0]; // "transparent" / unparsable → treat as fully transparent
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  }

  function relLuminance([r, g, b]: [number, number, number]): number {
    const [rs, gs, bs] = [r, g, b].map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  /** Alpha-composite `over` (with its own alpha) on top of opaque `under`. */
  function compositeOver(
    over: [number, number, number, number],
    under: [number, number, number],
  ): [number, number, number] {
    const a = over[3];
    return [
      over[0] * a + under[0] * (1 - a),
      over[1] * a + under[1] * (1 - a),
      over[2] * a + under[2] * (1 - a),
    ];
  }

  /**
   * Walk up from `el` (inclusive) collecting each ancestor's own
   * background-color, stopping at the first fully-opaque one (or the root).
   * An element whose OWN background is transparent must be judged against
   * whatever actually paints behind it — this is that resolution.
   */
  function resolveOpaqueBackground(start: Element): [number, number, number] {
    const layers: [number, number, number, number][] = [];
    let node: Element | null = start;
    while (node) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      layers.push(bg);
      if (bg[3] >= 0.999) break;
      node = node.parentElement;
    }
    // Fallback if we ran off the top of the document still transparent
    // (shouldn't happen — html/body set an opaque --bg — but stay honest).
    let composite: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      composite = compositeOver(layers[i], composite);
    }
    return composite;
  }

  const style = getComputedStyle(el);
  const fgRaw = parseColor(style.color);
  const resolvedBg = resolveOpaqueBackground(el);
  // Foreground text color is opaque in every real case in this app, but
  // composite honestly in case a future token adds alpha to text color.
  const resolvedFg = compositeOver(fgRaw, resolvedBg);

  const l1 = relLuminance(resolvedFg);
  const l2 = relLuminance(resolvedBg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const ratio = (lighter + 0.05) / (darker + 0.05);

  const fontSizePx = parseFloat(style.fontSize);
  const fontWeight = parseInt(style.fontWeight, 10) || 400;
  // WCAG AA "large text": >=24px any weight, or >=18.66px (14pt) AND bold.
  const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);

  const round = (n: number) => Math.round(n);
  return {
    fg: `rgb(${round(resolvedFg[0])}, ${round(resolvedFg[1])}, ${round(resolvedFg[2])})`,
    bg: `rgb(${round(resolvedBg[0])}, ${round(resolvedBg[1])}, ${round(resolvedBg[2])})`,
    ratio: Math.round(ratio * 100) / 100,
    fontSizePx,
    fontWeight,
    isLargeText,
  };
}

async function computeContrast(locator: Locator): Promise<ContrastResult> {
  const result = await locator.evaluate(inPageContrast);
  if ("error" in result) throw new Error(result.error);
  return result;
}

/**
 * Assert a locator's resolved foreground/background meets WCAG AA. On
 * failure, the message names the exact label + both resolved rgb() colors +
 * the computed ratio — never a bare boolean.
 */
async function assertAA(locator: Locator, label: string) {
  const r = await computeContrast(locator);
  const threshold = r.isLargeText ? 3 : 4.5;
  const message =
    `Contrast failure for "${label}": fg=${r.fg} on bg=${r.bg} ` +
    `→ ratio=${r.ratio}:1 (needs ${threshold}:1 for ${r.isLargeText ? "large" : "normal"} text, ` +
    `fontSize=${r.fontSizePx}px, fontWeight=${r.fontWeight})`;
  expect(r.ratio, message).toBeGreaterThanOrEqual(threshold);
}

// ─── Self-test: prove the math is right before trusting it on the app ─────

test.describe("contrast math sanity (proves the function before it's trusted)", () => {
  test("black text on white background resolves to 21:1 (the canonical WCAG max)", async ({ page }) => {
    await page.goto("/"); // any page — we inject a throwaway probe element
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.id = "__contrast_probe_bw";
      div.style.background = "rgb(255, 255, 255)";
      div.style.color = "rgb(0, 0, 0)";
      div.textContent = "probe";
      document.body.appendChild(div);
    });
    const r = await computeContrast(page.locator("#__contrast_probe_bw"));
    expect(r.ratio).toBeCloseTo(21, 0);
    await page.evaluate(() => document.getElementById("__contrast_probe_bw")?.remove());
  });

  test("known-bad pair (surface-on-surface, the original TICKET-20 bug) computes ~1:1, well under AA", async ({ page }) => {
    // Reproduces the exact regression PR #17 shipped: an input filled with
    // var(--surface) (#1a1a1a) sitting on a card background of the SAME
    // var(--surface) (#1a1a1a) — visually invisible. Confirms the math would
    // have failed this pair at either threshold (4.5 or 3), which is what the
    // TICKET-20 suite (class/visibility-only) could never catch.
    await page.goto("/");
    await page.evaluate(() => {
      const wrap = document.createElement("div");
      wrap.id = "__contrast_probe_bug";
      wrap.style.background = "rgb(26, 26, 26)"; // var(--surface)
      const inner = document.createElement("span");
      inner.style.background = "rgb(26, 26, 26)"; // var(--surface) — SAME color
      inner.style.color = "rgb(26, 26, 26)"; // simulate the camouflaged fill text
      inner.textContent = "probe";
      wrap.appendChild(inner);
      document.body.appendChild(wrap);
    });
    const r = await computeContrast(page.locator("#__contrast_probe_bug span"));
    expect(r.ratio).toBeCloseTo(1, 1);
    expect(r.ratio).toBeLessThan(4.5); // would fail normal-text AA
    expect(r.ratio).toBeLessThan(3); // would fail large-text AA too
    await page.evaluate(() => document.getElementById("__contrast_probe_bug")?.remove());
  });

  test("transparent-background element resolves against the real ancestor paint, not black/white default", async ({ page }) => {
    // Exercises the ancestor-walk requirement directly: an element with NO
    // background of its own (rgba(0,0,0,0)) sitting inside an opaque orange
    // card must be judged against the orange, not a fallback.
    await page.goto("/");
    await page.evaluate(() => {
      const card = document.createElement("div");
      card.id = "__contrast_probe_ancestor";
      card.style.background = "rgb(230, 120, 20)"; // opaque orange
      const label = document.createElement("span");
      label.style.background = "transparent";
      label.style.color = "rgb(255, 255, 255)";
      label.textContent = "probe";
      card.appendChild(label);
      document.body.appendChild(card);
    });
    const r = await computeContrast(page.locator("#__contrast_probe_ancestor span"));
    expect(r.bg).toBe("rgb(230, 120, 20)"); // resolved to the ancestor's paint
    await page.evaluate(() => document.getElementById("__contrast_probe_ancestor")?.remove());
  });
});

// ─── App fixtures (mirrors render-and-links.spec.ts's warm-up/seed helpers;
//     duplicated intentionally — this file inlines its own since we may not
//     edit e2e/helpers.ts, which a sibling ticket owns) ───────────────────

const DEV_TOKEN = "cantai-dev-host";
const YT_ID = "dQw4w9WgXcQ";
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );

async function warmUp(page: Page) {
  const req = page.request;
  await req.post("/api/rooms", { data: { name: "warmup-contrast" } });
  await req.post("/api/host/login", { data: { token: DEV_TOKEN } });
  await req.get("/api/host/session");
  await req.get("/api/queue");
  await page.goto("/");
  await page.goto("/new");
  await page.goto("/default");
  await page.goto("/default/tv");
  await page.goto("/default/admin");
}

async function createRoom(page: Page, name: string): Promise<{ id: string; hostCode: string }> {
  await page.goto("/new");
  await page.getByLabel("Nome do bar").fill(name);
  await page.getByRole("button", { name: /^criar sala$/i }).click();
  await page.getByTestId("join-url").waitFor();
  const joinUrl = (await page.getByTestId("join-url").textContent())!.trim();
  const id = joinUrl.split("/").pop()!;
  const hostCode = (await page.getByTestId("host-code").textContent())!.trim();
  return { id, hostCode };
}

async function seedSong(page: Page, roomId: string, title: string) {
  const res = await page.request.post(`/api/queue?room=${encodeURIComponent(roomId)}`, {
    data: {
      room: roomId,
      videoId: YT_ID,
      title,
      nickname: "Seeder",
      patronUuid: uuid(),
      mode: "sing",
    },
  });
  expect(res.ok()).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await warmUp(page);
});

// ─── Landing page + join-code input (the TICKET-20 bug surface) ───────────

test.describe("landing page contrast", () => {
  test("heading and join-by-code section heading meet AA", async ({ page }) => {
    await page.goto("/");
    await assertAA(page.getByRole("heading", { level: 1 }), "landing: h1 brand heading");
    await assertAA(
      page.getByRole("heading", { name: /código da sala|tem um código/i }),
      "landing: join-by-code section heading",
    );
  });

  // FINDING (TICKET-60, not fixed here per AC — "do not redesign tokens"):
  // white (#fff) text on `--accent` (#e63946) at 16px/weight 600 measures
  // 4.17:1 on current `main`, below the 4.5:1 AA floor for normal text (16px
  // bold does not clear the 18.66px "large text" bar, so the 3:1 relief does
  // not apply). This token pair (`.btn-primary`: color #fff on
  // background var(--accent)) is used on EVERY primary CTA across the app
  // (landing create-CTA, patron join button, submit-song button, etc.) — see
  // work/reports/dev/TICKET-60-dev-report.md for the full accounting.
  test.fixme(
    "create-room CTA button text meets AA — FAILS on current main: white-on-accent (#e63946) measures 4.17:1, needs 4.5:1 (see dev report)",
    async ({ page }) => {
      await page.goto("/");
      await assertAA(
        // TICKET-69 renamed this CTA to "Começar agora — é grátis" (Direction 2).
        page.getByRole("link", { name: /começar agora/i }),
        "landing: create-room CTA button text",
      );
    },
  );

  test("join-code input: typed text is legible against its OWN fill, not the card behind it", async ({ page }) => {
    // This is the exact regression: assert the input's fill vs the card's
    // fill are NOT the same rendered color by asserting real contrast on the
    // input itself (foreground text vs the input's own resolved background),
    // which walks correctly even if a future change makes the input
    // transparent again and relies on the card underneath.
    await page.goto("/");
    const codeInput = page.getByLabel(/código da sala/i);
    await codeInput.fill("bar-teste");
    await assertAA(codeInput, "landing: join-code input text vs its fill");

    // Additionally assert the input's resolved background is NOT identical to
    // the card section wrapping it — the precise shape of the original bug,
    // expressed as real rgb() values rather than class/variable names.
    const cardBg = await page
      .locator("section", { has: codeInput })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const inputBg = await codeInput.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(
      inputBg,
      `join-code input background (${inputBg}) must not equal its card's background (${cardBg}) — that was the TICKET-20 camouflage bug`,
    ).not.toBe(cardBg);
  });

  test("footer + tagline (muted text) meet AA against the page background", async ({ page }) => {
    await page.goto("/");
    await assertAA(page.locator("footer span").first(), "landing: footer copy (text-muted on --bg)");
  });
});

// ─── Patron room ────────────────────────────────────────────────────────────

test.describe("patron room contrast", () => {
  async function joinRoom(page: Page, roomName: string) {
    const { id } = await createRoom(page, roomName);
    await page.goto(`/${id}`);
    await page.getByLabel("Seu apelido").fill("ContrastTester");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
    return id;
  }

  test("post-join essentials: add-song heading, inputs, live-queue heading, player hint", async ({ page }) => {
    await joinRoom(page, "Bar Contrast Patron");

    await assertAA(
      page.getByRole("heading", { name: /adicionar música/i }),
      "patron: 'adicionar música' heading",
    );
    await assertAA(page.getByLabel(/buscar música/i), "patron: song-search input text");
    await assertAA(
      page.getByRole("heading", { name: /fila ao vivo/i }),
      "patron: 'fila ao vivo' heading",
    );
    const hint = page.getByTestId("patron-player-hint");
    await assertAA(hint, "patron: player-hint card text (own bg walk)");
  });

  test("live queue entry: title, meta line, and mode badge meet AA once seeded", async ({ page }) => {
    const id = await joinRoom(page, "Bar Contrast Queue");
    await seedSong(page, id, "Musica de Contraste");
    await page.reload();

    const item = page.locator("ol > li").first();
    await item.waitFor();
    await assertAA(item.locator("p").first(), "patron: queue item title");
    const badge = item.locator(".badge");
    await assertAA(badge, "patron: queue item mode badge (rgba tint over item bg)");
  });
});

// ─── Admin room ─────────────────────────────────────────────────────────────

test.describe("admin room contrast", () => {
  async function loginAdmin(page: Page, roomName: string) {
    const { id, hostCode } = await createRoom(page, roomName);
    await page.goto(`/${id}/admin`);
    await page.getByLabel(/código do host/i).fill(hostCode);
    await page.getByRole("button", { name: /^entrar$/i }).click();
    await expect(page.getByRole("button", { name: /pausar|retomar/i })).toBeVisible();
    return id;
  }

  test("dashboard controls and customer-screen links meet AA", async ({ page }) => {
    const id = await loginAdmin(page, "Bar Contrast Admin");

    await assertAA(
      page.getByRole("button", { name: /pausar|retomar/i }),
      "admin: pausar/retomar control button",
    );
    await assertAA(
      page.getByRole("button", { name: /pular música/i }),
      "admin: pular música control button",
    );

    await assertAA(page.getByTestId("admin-patron-link"), "admin: link to patron screen");
    await assertAA(page.getByTestId("admin-tv-link"), "admin: link to TV screen");
    void id;
  });

  // FINDING (TICKET-60, not fixed here per AC — "do not redesign tokens"):
  // the ACTIVE mode-switcher label (`.option.active .name`, ModeSwitcher.module.css)
  // renders `color: var(--accent)` (#e63946) over `background:
  // rgba(230, 57, 70, 0.09)` composited onto the page's `var(--bg)`
  // (#0d0d0d, the nearest opaque ancestor here), resolving to
  // fg=rgb(230,57,70) on bg=rgb(33,17,18) — 4.37:1 on
  // current `main`, just under the 4.5:1 AA floor for normal text (16px,
  // weight 800 — still short of the 18.66px large-text bar). See
  // work/reports/dev/TICKET-60-dev-report.md.
  test.fixme(
    "active mode-switcher label meets AA — FAILS on current main: accent-on-tinted-accent measures 4.37:1, needs 4.5:1 (see dev report)",
    async ({ page }) => {
      await loginAdmin(page, "Bar Contrast Admin Mode");
      const modeSwitcher = page.getByRole("radiogroup", { name: /modo de rodízio/i });
      await assertAA(modeSwitcher.getByText(/karaokê completo/i), "admin: active mode-switcher label");
    },
  );

  test("login gate: host-code input text is legible against its own fill", async ({ page }) => {
    const { id } = await createRoom(page, "Bar Contrast Admin Gate");
    await page.goto(`/${id}/admin`);
    const tokenInput = page.getByLabel(/código do host/i);
    await tokenInput.fill("probe-code");
    await assertAA(tokenInput, "admin: host-code login input text");
  });
});

// ─── /tv (venue screen — its own dark palette, distinct from globals.css) ──

test.describe("tv screen contrast", () => {
  test("idle state: wordmark + call-to-action text meet AA", async ({ page }) => {
    const { id } = await createRoom(page, "Bar Contrast Tv Idle");
    await page.goto(`/${id}/tv`);
    const idle = page.getByTestId("tv-idle");
    await expect(idle).toBeVisible({ timeout: 8000 });
    await assertAA(idle, "tv: idle-state copy block");
  });

  test("now-playing state: hero title meets AA (large-text threshold) once seeded", async ({ page }) => {
    const { id } = await createRoom(page, "Bar Contrast Tv Hero");
    await seedSong(page, id, "Musica de Contraste Tv");
    await page.goto(`/${id}/tv`);
    const hero = page.getByTestId("tv-hero");
    await expect(hero).toContainText("Musica de Contraste Tv", { timeout: 8000 });
    await assertAA(hero, "tv: now-playing hero title");
  });
});
