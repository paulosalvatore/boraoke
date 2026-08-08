import { metadata, viewport, ogImageForLocale } from "@/app/metadata";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { LOCALES, type Locale } from "@/i18n/locales";
import ptBR from "@/messages/pt-BR.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";

const CATALOGS: Record<Locale, { Meta: Record<string, string>; Landing: Record<string, string> }> = {
  "pt-BR": ptBR,
  en,
  es,
};

/**
 * Publish-readiness metadata (TICKET-33). Guards the Boraoke rebrand + the
 * OpenGraph/Twitter/theme wiring so a later edit can't silently drop the title,
 * canonical OG image, or brand name.
 */
describe("root layout metadata (TICKET-33 publish readiness)", () => {
  it("carries a Boraoke-branded title and description", () => {
    const title = metadata.title as { default?: string; template?: string };
    expect(title.default).toContain("Boraoke");
    expect(title.template).toContain("Boraoke");
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).length).toBeGreaterThan(0);
    // No stale old-brand string leaks into user-facing metadata.
    expect(JSON.stringify(metadata.title)).not.toMatch(/cantai/i);
  });

  it("sets the canonical production origin", () => {
    expect(metadata.metadataBase?.toString()).toBe("https://boraoke.com/");
  });

  it("wires OpenGraph to the pt-BR OG image", () => {
    const og = metadata.openGraph as {
      locale?: string;
      images?: Array<{ url: string }>;
      siteName?: string;
    };
    expect(og.siteName).toBe("Boraoke");
    expect(og.locale).toBe("pt_BR");
    expect(og.images?.[0]?.url).toBe("/brand/og-image-pt-BR.png");
  });

  it("wires a Twitter summary_large_image card", () => {
    const tw = metadata.twitter as { card?: string; images?: string[] };
    expect(tw.card).toBe("summary_large_image");
    expect(tw.images?.[0]).toBe("/brand/og-image-pt-BR.png");
  });

  it("references the web app manifest", () => {
    expect(metadata.manifest).toBe("/manifest.json");
  });

  it("sets the brand theme color", () => {
    expect(viewport.themeColor).toBe("#0D0A14");
  });

  // TICKET-73: without viewportFit "cover" the browser never exposes real
  // safe-area insets, so `env(safe-area-inset-*)` — which the feedback pill's
  // spacer depends on — silently resolves to 0 on every notched device.
  it("opts into the full viewport so safe-area insets resolve (TICKET-73)", () => {
    expect(viewport.viewportFit).toBe("cover");
  });
});

describe("per-locale OG image lookup (TICKET-30 i18n)", () => {
  it("returns the pt-BR image for pt-BR (the shipped variant)", () => {
    expect(ogImageForLocale("pt-BR")).toBe("/brand/og-image-pt-BR.png");
  });

  it("falls back to the pt-BR image for en/es (variants not shipped yet)", () => {
    // en/es OG cards are in flight; until they land the lookup MUST fall back to
    // the pt-BR image rather than emit a 404 social card.
    expect(ogImageForLocale("en")).toBe("/brand/og-image-pt-BR.png");
    expect(ogImageForLocale("es")).toBe("/brand/og-image-pt-BR.png");
  });
});
// ─── TICKET-74: metadata copy contract ───────────────────────────────────────

describe("Meta catalog copy (TICKET-74)", () => {
  // Real SEO truncation limits. Google renders roughly the first ~60 chars of a
  // title and ~155-160 of a description; an OG description previews shorter
  // still. These are asserted, never eyeballed.
  const LIMITS = { title: 60, description: 160, ogDescription: 100 } as const;
  const META_KEYS = ["title", "description", "ogDescription"] as const;

  for (const locale of LOCALES) {
    it(`${locale} carries all three Meta keys, non-empty`, () => {
      const meta = CATALOGS[locale].Meta;
      for (const key of META_KEYS) {
        expect(typeof meta[key]).toBe("string");
        expect(meta[key].trim().length).toBeGreaterThan(0);
      }
    });

    it(`${locale} stays within the SEO character limits`, () => {
      const meta = CATALOGS[locale].Meta;
      for (const key of META_KEYS) {
        // Count user-perceived characters, not UTF-16 code units.
        expect([...meta[key]].length).toBeLessThanOrEqual(LIMITS[key]);
      }
    });

    it(`${locale} keeps the OG description shorter than the meta description`, () => {
      const meta = CATALOGS[locale].Meta;
      expect([...meta.ogDescription].length).toBeLessThan([...meta.description].length);
    });

    // The landing is deliberately venue-agnostic (bar / festa / condomínio /
    // empresa). Metadata that still says "your bar's queue" contradicts the page
    // it describes, which is exactly the defect TICKET-74 fixed.
    it(`${locale} no longer frames the product as bar-only`, () => {
      const joined = Object.values(CATALOGS[locale].Meta).join(" ");
      expect(joined).not.toMatch(/do seu bar|de tu bar|your bar/i);
    });

    // No stale old-brand string leaks into user-facing metadata, in ANY locale.
    it(`${locale} leaks no old-brand string`, () => {
      expect(JSON.stringify(CATALOGS[locale].Meta)).not.toMatch(/cantai/i);
    });
  }

  // The static pt-BR baseline in app/metadata.ts and the pt-BR catalog consumed
  // by generateMetadata are two renderings of the SAME copy. If they drift, a
  // reader finds two different descriptions of the product depending on which
  // path served the page. Pin them together.
  it("keeps app/metadata.ts identical to the pt-BR Meta catalog", () => {
    const meta = CATALOGS["pt-BR"].Meta;
    const title = metadata.title as { default?: string };
    const og = metadata.openGraph as { title?: string; description?: string };
    const tw = metadata.twitter as { title?: string; description?: string };

    expect(title.default).toBe(meta.title);
    expect(metadata.description).toBe(meta.description);
    expect(og.title).toBe(meta.title);
    expect(og.description).toBe(meta.ogDescription);
    expect(tw.title).toBe(meta.title);
    expect(tw.description).toBe(meta.ogDescription);
  });
});

describe("free-tier copy makes no forward-looking promise (TICKET-74)", () => {
  // A public page must not commit the business to pricing it has not decided.
  // "free today" is a fact; "and stays free" is an open-ended commercial
  // guarantee. Guard the whole family of ways to re-introduce one.
  const FOREVER =
    /continua gr[áa]tis|stays free|sigue gratis|forever|para sempre|sempre gr[áa]tis|siempre gratis|para siempre|no paywall|sem paywall|sin paywall/i;

  for (const locale of LOCALES) {
    it(`${locale} free-promise line states only the present tense`, () => {
      const promise = CATALOGS[locale].Landing.freePromise;
      expect(typeof promise).toBe("string");
      expect(promise.trim().length).toBeGreaterThan(0);
      expect(promise).not.toMatch(FOREVER);
    });

    it(`${locale} metadata carries no free-forever claim either`, () => {
      expect(JSON.stringify(CATALOGS[locale].Meta)).not.toMatch(FOREVER);
    });
  }
});

// ─── TICKET-74: sitemap + robots ─────────────────────────────────────────────

describe("sitemap (TICKET-74)", () => {
  const urls = sitemap().map((e) => e.url);

  it("lists exactly the public, non-room routes", () => {
    expect(urls).toEqual(["https://boraoke.com/", "https://boraoke.com/new"]);
  });

  it("enumerates no room-scoped URL", () => {
    // Room routes are dynamic, ephemeral and semi-private. A sitemap that
    // enumerated them would be both wrong and impossible to keep true.
    for (const url of urls) {
      expect(url).not.toMatch(/\/admin|\/tv/);
    }
  });

  it("uses the canonical origin for every entry", () => {
    for (const url of urls) {
      expect(url.startsWith("https://boraoke.com/")).toBe(true);
    }
  });
});

describe("robots (TICKET-74)", () => {
  const r = robots();
  const rules = r.rules as { userAgent?: string; allow?: string[]; disallow?: string };

  it("advertises the sitemap at the canonical origin", () => {
    expect(r.sitemap).toBe("https://boraoke.com/sitemap.xml");
  });

  it("disallows everything by default so room pages are not crawled", () => {
    expect(rules.disallow).toBe("/");
  });

  it("allows the assets a crawler needs to render the allowed pages", () => {
    expect(rules.allow).toContain("/_next/");
    expect(rules.allow).toContain("/brand/");
  });

  // A robots policy asserted only by "the array contains this string" is close
  // to vacuous: it cannot see that `Allow: /new` PREFIX-matches `/new-year-party`
  // and quietly lets every room whose slug starts with "new" back into the
  // crawl. So decide the policy the way a crawler does — evaluate real paths
  // through RFC 9309 matching (`*` wildcard, `$` end-anchor, longest match
  // wins, Allow breaks a tie).
  function decide(path: string): "ALLOW" | "BLOCK" {
    const score = (pattern: string): number => {
      const anchored = pattern.endsWith("$");
      const body = anchored ? pattern.slice(0, -1) : pattern;
      const re = new RegExp(
        "^" +
          body
            .split("*")
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          (anchored ? "$" : ""),
      );
      // Specificity is the literal length of the pattern, per RFC 9309.
      return re.test(path) ? body.length : -1;
    };
    const bestAllow = Math.max(-1, ...(rules.allow ?? []).map(score));
    const bestDisallow = Math.max(-1, ...[rules.disallow ?? ""].map(score));
    if (bestAllow < 0 && bestDisallow < 0) return "ALLOW";
    return bestAllow >= bestDisallow ? "ALLOW" : "BLOCK";
  }

  it("allows exactly the public pages", () => {
    expect(decide("/")).toBe("ALLOW");
    expect(decide("/new")).toBe("ALLOW");
  });

  it("keeps the advertised sitemap crawlable", () => {
    // `Disallow: /` would otherwise block the very file `sitemap` points at.
    expect(decide("/sitemap.xml")).toBe("ALLOW");
  });

  it("blocks room pages, including slugs that merely start with a public path", () => {
    expect(decide("/bar-do-ze")).toBe("BLOCK");
    expect(decide("/default")).toBe("BLOCK");
    // The regression that a "contains /new" assertion cannot catch: these are
    // real, creatable rooms — only the exact id `new` is reserved.
    expect(decide("/new-year-party")).toBe("BLOCK");
    expect(decide("/newton-bar")).toBe("BLOCK");
  });

  it("blocks host-only and screen-only surfaces", () => {
    expect(decide("/default/admin")).toBe("BLOCK");
    expect(decide("/default/tv")).toBe("BLOCK");
    expect(decide("/admin")).toBe("BLOCK");
    expect(decide("/admin/analytics")).toBe("BLOCK");
  });

  it("still lets a renderer fetch the assets of the allowed pages", () => {
    expect(decide("/_next/static/chunks/main.js")).toBe("ALLOW");
    expect(decide("/brand/og-image-pt-BR.png")).toBe("ALLOW");
    expect(decide("/manifest.json")).toBe("ALLOW");
  });
});
