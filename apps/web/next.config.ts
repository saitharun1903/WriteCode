import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev indicator covers the tool-window stripe in the bottom-left corner.
  devIndicators: false,
  // Production images serve the IDE as static files from the reverse proxy (no Node server).
  ...(process.env.NEXT_OUTPUT === "export" ? { output: "export" as const } : {}),
};

export default nextConfig;
