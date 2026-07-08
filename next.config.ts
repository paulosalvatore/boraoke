import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// i18n (TICKET-30): next-intl WITHOUT i18n routing — locale lives in the
// NEXT_LOCALE cookie, NOT the URL, so room URLs stay `/<room>`. The plugin only
// wires the request config below; it adds no path segment and no middleware.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
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
