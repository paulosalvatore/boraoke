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
      <head>
        {/*
          TICKET-99: globalThis shim, must run BEFORE any Next.js chunk.
          `globalThis` landed in Chrome 71; the pinned floor is Chrome 68
          (webOS 4.5/5.0), so 68-70 lack it. Next's own client runtime
          references it unguarded in at least one chunk (crypto hashing,
          error-reporting fallback), and Next loads its polyfills chunk
          LAST in the script order — so Next's own polyfilling cannot save
          this even in principle. An inline head script runs before any
          async/deferred chunk script, which is why it goes here rather
          than in a client component. Standard shim shape (same technique
          core-js's es.global-this polyfill uses): grab `this` at the
          global scope via an accessor on Object.prototype, assign it once,
          then remove the temporary property so it can't leak. Guarded by
          `typeof globalThis !== "object"` so it is a no-op — and cannot
          throw — on every modern browser that already has the real thing.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){if(typeof globalThis!=="object"){Object.defineProperty(Object.prototype,"__gt99__",{get:function(){return this},configurable:true});__gt99__.globalThis=__gt99__;delete Object.prototype.__gt99__}})();',
          }}
        />
      </head>
      <body>
        <NextIntlClientProvider>
          {children}
          <FeedbackWidget />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
