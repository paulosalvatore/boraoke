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
  // en/es OG variants come with the i18n wave (wave-30: hreflang + locale-aware
  // OG). For now the default is pt-BR pointed at the pt-BR-first OG image.
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
        url: "/brand/og-image.png",
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
    images: ["/brand/og-image.png"],
  },
  // Favicons come from the App-Router file convention (app/icon.png +
  // app/apple-icon.png), which Next auto-injects the <link> tags for. The
  // manifest carries the larger PWA icons (192/512).
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#0D0A14",
};
