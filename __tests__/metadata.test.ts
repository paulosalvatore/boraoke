import { metadata, viewport, ogImageForLocale } from "@/app/metadata";

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
