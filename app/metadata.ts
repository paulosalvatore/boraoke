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
    default: "Boraoke — a fila de karaokê do seu bar",
    template: "%s · Boraoke",
  },
  description:
    "A fila de karaokê do seu bar, no celular de cada cliente. Crie a sala, mostre o QR, e todo mundo entra na fila com a mesa marcada. Grátis para começar.",
  applicationName: "Boraoke",
  // Per-locale OG scheme: /brand/og-image-<locale>.png (PR #19). en/es variants
  // + hreflang/locale-aware selection come with the i18n wave (wave-30). For
  // now the default is pt-BR pointed at the pt-BR image.
  openGraph: {
    type: "website",
    siteName: "Boraoke",
    locale: "pt_BR",
    url: SITE_URL,
    title: "Boraoke — a fila de karaokê do seu bar",
    description:
      "A fila de karaokê do seu bar, no celular de cada cliente. Grátis para começar.",
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
    title: "Boraoke — a fila de karaokê do seu bar",
    description:
      "A fila de karaokê do seu bar, no celular de cada cliente. Grátis para começar.",
    images: ["/brand/og-image-pt-BR.png"],
  },
  // Favicons come from the App-Router file convention (app/icon.png +
  // app/apple-icon.png), which Next auto-injects the <link> tags for. The
  // manifest carries the larger PWA icons (192/512).
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#0D0A14",
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
