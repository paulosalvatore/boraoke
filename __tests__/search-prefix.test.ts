/**
 * TICKET-108 — unit suite for the prefix-extension search planner.
 *
 * Jest here is node-env (no jsdom), which is exactly why the decision logic lives
 * in a pure helper instead of inside `SongSearch`: it can be driven directly.
 *
 * The suite has two halves, and the second is the one that matters:
 *
 *   1. unit behaviour of `normalizeQuery` / `isExtensionOf` / `filterResults` /
 *      `planSearch`, on small hand-written inputs;
 *   2. a REPLAY of the real production keystroke ladder that caused this ticket,
 *      against the real YouTube pages production served for it. That fixture is
 *      the production search cache read on 2026-09-27 and committed under
 *      `work/measurements/ticket-108/`. A hand-written fixture cannot test this
 *      honestly, because the whole question is whether a short prefix's REAL
 *      top-50 contains the song — which is a fact about YouTube, not about us.
 *
 * `prove-your-test-can-fail`: the mutation that kills the assertions here, and
 * the verbatim reverse-check output against the pre-fix behaviour, are recorded
 * in `work/reports/dev/TICKET-108-dev-report.md`.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  MIN_LOCAL_MATCHES,
  filterResults,
  isExtensionOf,
  normalizeQuery,
  planSearch,
  queryTokens,
} from "@/lib/search-prefix";
import type { SearchResult } from "@/lib/youtube-search";

// ── helpers ───────────────────────────────────────────────────────────────────

function row(title: string, channelTitle = "Karaokê Canal"): SearchResult {
  return {
    videoId: `v${Math.abs(hash(title + channelTitle))}`,
    title,
    channelTitle,
    duration: "3:00",
    thumbnailUrl: "https://i.ytimg.com/vi/x/mqdefault.jpg",
  };
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
/** N filler rows that match `stem` so a page can be made deliberately non-starving. */
function fillers(stem: string, n: number): SearchResult[] {
  return Array.from({ length: n }, (_, i) => row(`${stem} versão ${i}`));
}

describe("normalizeQuery", () => {
  it("folds case, diacritics, punctuation and whitespace", () => {
    expect(normalizeQuery("  Evidências ")).toBe("evidencias");
    expect(normalizeQuery("Cerol na Mão!")).toBe("cerol na mao");
    expect(normalizeQuery("zé  ramalho")).toBe("ze ramalho");
    expect(normalizeQuery("Maná")).toBe(normalizeQuery("mana"));
  });

  it("returns empty for whitespace-only input, and tokenizes nothing from it", () => {
    expect(normalizeQuery("   ")).toBe("");
    expect(queryTokens("   ")).toEqual([]);
  });
});

describe("isExtensionOf", () => {
  it("accepts continuing mid-word and at a word boundary", () => {
    expect(isExtensionOf("escurinho", "escuri")).toBe(true);
    expect(isExtensionOf("escurinho do", "escurinho")).toBe(true);
  });

  it("is diacritic-insensitive, so adding an accent does not read as a new query", () => {
    // Production billed a separate call for `evidências` after `evide`.
    expect(isExtensionOf("evidências", "evide")).toBe(true);
    expect("evidências".startsWith("evide")).toBe(false); // unfolded, it would not
  });

  it("rejects an equal query, a backspace, and an unrelated query", () => {
    expect(isExtensionOf("mana", "mana")).toBe(false);
    expect(isExtensionOf("maná", "mana")).toBe(false); // equal once folded
    expect(isExtensionOf("escuri", "escurinho")).toBe(false); // backspace
    expect(isExtensionOf("borbulhas", "escurinho")).toBe(false);
  });

  it("rejects anything when there is no held query", () => {
    expect(isExtensionOf("escurinho", "")).toBe(false);
  });
});

describe("filterResults", () => {
  const page = [
    row("Escurinho do Cinema - Rita Lee (Playback)"),
    row("Flagra - Rita Lee", "Playback Musical"),
    row("Borbulhas de Amor - Fagner"),
  ];

  it("prefix-matches a half-typed trailing word", () => {
    // "cin" must reach "Cinema" or narrowing starves on every keystroke.
    expect(filterResults(page, "escurinho do cin").map((r) => r.title)).toEqual([
      "Escurinho do Cinema - Rita Lee (Playback)",
    ]);
  });

  it("is order-insensitive across title and channel", () => {
    expect(filterResults(page, "rita escurinho")).toHaveLength(1);
    expect(filterResults(page, "playback flagra")).toHaveLength(1);
  });

  it("ignores non-discriminating tokens rather than rejecting rows that omit them", () => {
    // A row titled without the article must survive "borbulhas de".
    const noArticle = [row("Borbulhas Amor")];
    expect(filterResults(noArticle, "borbulhas de amor")).toHaveLength(1);
    // ...and the karaoke keyword must not be required of the row.
    expect(filterResults([row("Flagra", "Só Playback")], "flagra karaoke")).toHaveLength(1);
  });

  it("returns every row when the query carries no discriminating token", () => {
    expect(filterResults(page, "de do da")).toHaveLength(page.length);
  });

  it("returns nothing when no row can match", () => {
    expect(filterResults(page, "escurinho zzzz")).toEqual([]);
  });
});

describe("planSearch", () => {
  const held = [row("Escurinho do Cinema - Rita Lee"), ...fillers("Escurinho do Cinema", 9)];

  it("fetches when nothing is held", () => {
    expect(planSearch({ next: "escurinho", heldQuery: "", heldRows: [] })).toEqual({
      action: "fetch",
      reason: "no-held-results",
    });
    expect(planSearch({ next: "escurinho", heldQuery: "escuri", heldRows: [] })).toEqual({
      action: "fetch",
      reason: "no-held-results",
    });
  });

  it("fetches for an unrelated query and for a backspace", () => {
    expect(planSearch({ next: "borbulhas", heldQuery: "escurinho", heldRows: held })).toEqual({
      action: "fetch",
      reason: "not-an-extension",
    });
    expect(planSearch({ next: "escuri", heldQuery: "escurinho", heldRows: held })).toEqual({
      action: "fetch",
      reason: "not-an-extension",
    });
  });

  it("NARROWS an extension locally — no call — when enough rows survive", () => {
    const plan = planSearch({ next: "escurinho do cinema", heldQuery: "escurinho", heldRows: held });
    expect(plan.action).toBe("filter");
    if (plan.action !== "filter") throw new Error("unreachable");
    expect(plan.rows).toHaveLength(held.length);
  });

  it("REFETCHES rather than showing a starved list — the quality guardrail", () => {
    // Only one row can match, which is below MIN_LOCAL_MATCHES: the held page
    // cannot really answer this query, so spending a call is the honest move.
    const thin = [row("Escurinho do Cinema"), row("Borbulhas de Amor"), row("Vida de Gado")];
    expect(planSearch({ next: "escurinho do cinema", heldQuery: "escurinho", heldRows: thin })).toEqual({
      action: "fetch",
      reason: "local-matches-starved",
    });
  });

  it("treats a re-spelling as the same query and hands back the held rows untouched", () => {
    // Production billed twice for `mana`/`maná` and twice for `cerol na mao`/`mão`.
    for (const [a, b] of [
      ["mana", "maná"],
      ["cerol na mao", "cerol na mão"],
    ]) {
      const plan = planSearch({ next: b, heldQuery: a, heldRows: held });
      expect(plan.action).toBe("filter");
      if (plan.action !== "filter") throw new Error("unreachable");
      expect(plan.rows).toEqual(held); // unchanged, not re-narrowed
    }
  });

  it("honours the MIN_LOCAL_MATCHES boundary exactly", () => {
    const stem = "Escurinho do Cinema";
    const exactly = fillers(stem, MIN_LOCAL_MATCHES);
    const oneShort = fillers(stem, MIN_LOCAL_MATCHES - 1);
    expect(planSearch({ next: `${stem} x`.trim(), heldQuery: "escurinho", heldRows: exactly }).action).toBe(
      "fetch", // "x" matches nothing → starved
    );
    expect(planSearch({ next: stem, heldQuery: "escurinho", heldRows: exactly }).action).toBe("filter");
    expect(planSearch({ next: stem, heldQuery: "escurinho", heldRows: oneShort })).toEqual({
      action: "fetch",
      reason: "local-matches-starved",
    });
  });
});

// ── the production regression ─────────────────────────────────────────────────

/**
 * The real pages production served, read from the committed measurement fixture.
 * Keys are the AUGMENTED query (sing mode appends "karaoke"), so the ladder below
 * is expressed in raw-input space and mapped through `pageFor`.
 */
const FIXTURE: Record<string, { videoId: string; title: string; channelTitle: string }[]> = JSON.parse(
  readFileSync(join(__dirname, "..", "work", "measurements", "ticket-108", "production-search-results.json"), "utf8"),
);

function pageFor(raw: string): SearchResult[] {
  const rows = FIXTURE[`${raw} karaoke`] ?? FIXTURE[raw];
  if (!rows) throw new Error(`fixture has no page for "${raw}" — the fixture, not the code, is wrong`);
  return rows.map((r) => ({ ...r, duration: "", thumbnailUrl: "" }));
}

/** The exact keystroke ladder that burned 12 of the platform's 90 daily calls. */
const ESCURINHO_LADDER = [
  "escu",
  "escur",
  "escuri",
  "escurinh",
  "escurinho",
  "escurinho d",
  "escurinho do",
  "escurinho do c",
  "escurinho do ci",
  "escurinho do cin",
  "escurinho do cinema",
];

/** Replay a raw-input ladder through the planner against the real pages. */
function replayLadder(ladder: string[]): { billed: number; reasons: string[]; finalRows: SearchResult[] } {
  let heldQuery = "";
  let heldRows: SearchResult[] = [];
  let billed = 0;
  const reasons: string[] = [];
  let shown: SearchResult[] = [];
  for (const raw of ladder) {
    const plan = planSearch({ next: raw, heldQuery, heldRows });
    if (plan.action === "fetch") {
      billed++;
      reasons.push(plan.reason);
      heldQuery = raw;
      heldRows = pageFor(raw);
      shown = heldRows;
    } else {
      shown = plan.rows;
    }
  }
  return { billed, reasons, finalRows: shown };
}

describe("production regression: the escurinho ladder (TICKET-108)", () => {
  it("is still the 11-call disaster it was, if every step is treated as a new query", () => {
    // Positive control on the FIXTURE, not on our code: proves the ladder really
    // does consist of 11 separately-billed production queries, so the assertion
    // below is measured against something real rather than against an empty set.
    expect(ESCURINHO_LADDER).toHaveLength(11);
    for (const raw of ESCURINHO_LADDER) expect(pageFor(raw).length).toBeGreaterThan(0);
  });

  it("collapses the ladder from 11 billed calls to 6", () => {
    const { billed } = replayLadder(ESCURINHO_LADDER);
    // The pre-fix code billed one call per step: 11.
    expect(billed).toBeLessThan(ESCURINHO_LADDER.length);
    // Pinned to the MEASURED value rather than a loose threshold, so any future
    // change to the planner or its thresholds has to move this number on purpose.
    //
    // Read this honestly: 6 is a 45% cut on the WORST family in the corpus, not
    // the ~4x the quota headroom was originally hoped to be. This ladder is the
    // hard case — "escu" is far too short for YouTube to surface Rita Lee's
    // "Escurinho do Cinema" at all, so the held page genuinely cannot answer the
    // longer query and the guardrail correctly pays for a real call. Squeezing
    // those last calls out would mean showing the patron a page that does not
    // contain their song, which is precisely the trade this ticket refuses to
    // make silently. Corpus-wide the cut is 40% (80 → 48 calls).
    expect(billed).toBe(6);
  });

  it("still finds the song the patron was typing — the billing win is not paid for in quality", () => {
    const { finalRows } = replayLadder(ESCURINHO_LADDER);
    const found = finalRows
      .slice(0, 10)
      .some((r) => normalizeQuery(`${r.title} ${r.channelTitle}`).includes("escurinho"));
    expect(found).toBe(true);
  });

  it("spends its calls on starvation, not on blind re-querying", () => {
    const { reasons } = replayLadder(ESCURINHO_LADDER);
    // Exactly one unavoidable first call, and every other call is the guardrail
    // deciding the held page could not answer — never "not-an-extension", which
    // on a monotonically-typed ladder would mean the extension check is broken.
    expect(reasons[0]).toBe("no-held-results");
    expect(reasons.slice(1).every((r) => r === "local-matches-starved")).toBe(true);
  });

  it("charges nothing at all for a ladder whose first page already answers it", () => {
    // `borbulhas` → `borbulhas de` is the shape the fix is built for: the page for
    // the shorter query genuinely contains the song, so the extra keystrokes are free.
    const { billed } = replayLadder(["borbulhas", "borbulhas de"]);
    expect(billed).toBe(1);
  });
});
