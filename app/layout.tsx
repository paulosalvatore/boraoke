import "./globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { FeedbackWidget } from "@/components/FeedbackWidget";

// Locale-aware metadata (TICKET-30): `generateMetadata` follows the request
// locale (title/description/OG image) with a pt-BR fallback. `viewport` stays
// static.
export { generateMetadata } from "./generate-metadata";
export { viewport } from "./metadata";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // i18n (TICKET-30): locale comes from the NEXT_LOCALE cookie / Accept-Language
  // via i18n/request.ts — never from the URL (rooms stay /<room>). `<html lang>`
  // is now DYNAMIC (design audit L1: it was hardcoded pt-BR even for en/es
  // visitors, breaking SEO / screen readers / autotranslate).
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          {children}
          <FeedbackWidget />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
