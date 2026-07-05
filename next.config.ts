import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow YouTube iframe embedding in CSP — IFrame Player API is the only playback mechanism (ToS)
};

export default nextConfig;
