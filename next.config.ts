import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// i18n (TICKET-30): next-intl WITHOUT i18n routing — locale lives in the
// NEXT_LOCALE cookie, NOT the URL, so room URLs stay `/<room>`. The plugin only
// wires the request config below; it adds no path segment and no middleware.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // TICKET-98 — the LG TV failure of 2026-08-27. Next.js transpiles OUR source
  // to the browserslist target but does NOT downlevel node_modules, so a
  // dependency's own published syntax goes into the client bundle untouched.
  // `next-intl`'s ICU message parser ships `static {}` class initialization
  // blocks (ES2022, Chrome 94+) and `uuid` v11 ships `??`/`?.` (ES2020,
  // Chrome 80+). LG webOS browsers are Chromium pinned by firmware — webOS 6 is
  // Chrome 79, webOS 22 is 87 — so those chunks could not be PARSED, and a chunk
  // that cannot be parsed never executes: the whole app failed to boot, which is
  // exactly what the Tech Lead saw (no page, no QR, every song erroring).
  //
  // Listing them here downlevels them with our own code. `scripts/check-bundle-es-target.mjs`
  // is what proves it — it parses every emitted chunk at the target level, so this
  // list can never silently fall out of date as dependencies change.
  transpilePackages: [
    "next-intl",
    "use-intl",
    "intl-messageformat",
    "@formatjs/icu-messageformat-parser",
    "@formatjs/icu-skeleton-parser",
    "@formatjs/fast-memoize",
    "@formatjs/intl-localematcher",
    "uuid",
  ],
  // Allow YouTube iframe embedding in CSP — IFrame Player API is the only playback mechanism (ToS)

  // Canonical domain (TICKET-33): the old Vercel apex permanently (308) redirects
  // to https://boraoke.com, preserving the path. Host-matched so ONLY the vercel
  // apex is caught — boraoke.com traffic is never redirected onto itself.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "cantai-snowy.vercel.app" }],
        destination: "https://boraoke.com/:path*",
        permanent: true,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
