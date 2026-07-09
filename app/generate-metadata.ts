import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { OG_LOCALE, type Locale } from "@/i18n/locales";
import { SITE_URL, ogImageForLocale } from "./metadata";

/**
 * Locale-aware metadata (TICKET-30). Next.js prefers `generateMetadata` over the
 * static `metadata` export when both exist; the root layout re-exports THIS.
 * Title, description, and the OG image/locale all follow the request locale
 * (cookie / Accept-Language via i18n/request.ts), with pt-BR as the fallback for
 * both copy and image. The static `metadata` in `./metadata` is retained as the
 * pt-BR baseline (and its unit test).
 *
 * Kept in its own file (not `metadata.ts`) so the `next-intl/server` ESM import
 * never reaches the unit-testable `metadata.ts` under ts-jest/CJS.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations({ locale, namespace: "Meta" });
  const title = t("title");
  const description = t("description");
  const ogDescription = t("ogDescription");
  const ogImage = ogImageForLocale(locale);

  return {
    metadataBase: new URL(SITE_URL),
    title: { default: title, template: "%s · Boraoke" },
    description,
    applicationName: "Boraoke",
    openGraph: {
      type: "website",
      siteName: "Boraoke",
      locale: OG_LOCALE[locale],
      url: SITE_URL,
      title,
      description: ogDescription,
      images: [{ url: ogImage, width: 1200, height: 630, alt: "Boraoke" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: ogDescription,
      images: [ogImage],
    },
    manifest: "/manifest.json",
  };
}
