import type { NextConfig } from "next";

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

export default nextConfig;
