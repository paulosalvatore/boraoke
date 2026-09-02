import Script from "next/script";
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
          TICKET-99: globalThis shim for Chrome 68-70 / webOS 4.5-5.0.
          `globalThis` landed in Chrome 71; the pinned floor is Chrome 68, so
          68-70 lack it. Next's own emitted client runtime makes UNGUARDED
          references to it (crypto hashing, an error-reporting fallback) in
          at least one chunk, which throws a ReferenceError before React ever
          hydrates. Next loads its own polyfills chunk LAST in script order,
          so Next's own polyfilling cannot fix this even in principle.

          ORDERING, STATED HONESTLY (a prior version of this comment claimed
          an ordering guarantee that isn't real, per opus review D-022 F3):
          React 19 hoists Next's bootstrap `<script async>` tags to the top
          of <head>, ahead of this component's own <head> children — so a
          plain inline <script> here is NOT emitted before the chunk tags in
          the HTML. It used to work anyway only because `async` scripts must
          complete a network fetch before executing, and the whole <head> is
          small enough that the parser reaches this inline script well within
          that window — a race won by network latency, not a guarantee.

          `next/script` with `strategy="beforeInteractive"` is Next's
          documented, purpose-built mechanism for exactly this case (a
          polyfill that must run before hydration and before any page
          script): it injects the script so it executes before Next
          hydrates the page, which is an actual ordering guarantee rather
          than a timing race. See:
          https://nextjs.org/docs/app/api-reference/components/script#beforeinteractive

          Shim body (opus review F6/F7): a plain assignment on `window`, not
          the core-js-style Object.prototype accessor trick this used to use.
          That trick exists so core-js can find the global in ANY realm
          (browser, worker, Node); this runs in exactly one place — an HTML
          <head>, where `window` is guaranteed to be the global object — so
          the simpler form is equivalent, cannot leave prototype residue if a
          later statement throws, and matches the native descriptor shape
          (non-enumerable) that the Object.prototype trick did not. Guarded
          by `typeof globalThis !== "object"` so it is a no-op on every
          modern browser that already has the real thing.
        */}
        <Script id="ticket-99-globalthis-shim" strategy="beforeInteractive">
          {'(function(){if(typeof globalThis!=="object"){Object.defineProperty(window,"globalThis",{value:window,writable:true,configurable:true})}})();'}
        </Script>
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
