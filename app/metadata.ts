import type { Metadata, Viewport } from "next";

// Canonical production origin. Kept in sync with the next.config redirect and
// the TM-owned NEXTAUTH_URL / OAuth origins (see TICKET-33 PR body follow-ups).
export const SITE_URL = "https://boraoke.com";

// Publish-readiness metadata (TICKET-33). Split out of app/layout.tsx so it can
// be unit-tested without pulling the layout's CSS / client-component imports
// into the node test env.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // Per-page titles slot into the template; the root default is the home title.
  title: {
    default: "Boraoke — a fila do karaokê na TV, no celular de todos",
    template: "%s · Boraoke",
  },
  description:
    "Bar, festa, condomínio ou empresa: cada pessoa escaneia o QR e escolhe a música no celular. A TV toca a fila sozinha, em rodízio justo. Sem app, grátis.",
  applicationName: "Boraoke",
  // Per-locale OG scheme: /brand/og-image-<locale>.png (PR #19). en/es card
  // variants are still in flight (design); the lookup below falls back to the
  // pt-BR image so a social card is never a 404.
  //
  // NO `alternates.languages` hreflang here, deliberately (TICKET-74). hreflang
  // annotates DISTINCT URLs per language version; this app serves all three
  // locales from the SAME URL, resolved from the NEXT_LOCALE cookie /
  // Accept-Language (i18n/locales.ts — rooms must stay `/<room>`, so there is
  // no `[locale]` segment). Emitting three hreflang entries that all point at
  // one URL is invalid and is ignored by search engines. Real hreflang requires
  // per-locale URLs, i.e. a routing change, not a metadata change.
  openGraph: {
    type: "website",
    siteName: "Boraoke",
    locale: "pt_BR",
    url: SITE_URL,
    title: "Boraoke — a fila do karaokê na TV, no celular de todos",
    description:
      "Cada pessoa escaneia o QR e escolhe a música. A TV toca a fila sozinha, em rodízio justo. Grátis.",
    images: [
      {
        url: "/brand/og-image-pt-BR.png",
        width: 1200,
        height: 630,
        alt: "Boraoke",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Boraoke — a fila do karaokê na TV, no celular de todos",
    description:
      "Cada pessoa escaneia o QR e escolhe a música. A TV toca a fila sozinha, em rodízio justo. Grátis.",
    images: ["/brand/og-image-pt-BR.png"],
  },
  // Favicons come from the App-Router file convention (app/icon.png +
  // app/apple-icon.png), which Next auto-injects the <link> tags for. The
  // manifest carries the larger PWA icons (192/512).
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#0D0A14",
  // TICKET-73: opt the page into the full device viewport so `env(safe-area-inset-*)`
  // resolves to REAL values on notched / home-indicator devices instead of 0. Without
  // this, the safe-area spacer TICKET-71 shipped on the feedback pill is present in the
  // CSS but permanently inert in production. `cover` lets content extend under the
  // notch/indicator, so any element that must stay clear of them has to consume the
  // insets itself — today that is the feedback pill's spacer, which already does.
  viewportFit: "cover",
};

// ─── Per-locale OG image lookup (TICKET-30 i18n wave) ────────────────────────
// NOTE: this file must stay free of `next-intl/server` (ESM) imports so it can
// be unit-tested under ts-jest/CJS. The async, locale-aware `generateMetadata`
// lives in `app/generate-metadata.ts`; only these pure helpers live here.

import type { Locale } from "@/i18n/locales";

/**
 * OG images that actually exist in `public/brand/`. og-image-pt-BR.png ships
 * today; en/es cards are in flight (design). Until a variant lands here, the
 * lookup falls back to the pt-BR image — never a 404 social card. When the
 * en/es PNGs land, add their locales to this set (single edit).
 */
const OG_IMAGE_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["pt-BR"]);

/** Resolve the OG image path for a locale, falling back to pt-BR. */
export function ogImageForLocale(locale: Locale): string {
  const l = OG_IMAGE_LOCALES.has(locale) ? locale : "pt-BR";
  return `/brand/og-image-${l}.png`;
}
