import type { MetadataRoute } from "next";
import { SITE } from "@/features/seo/pages";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE.name}: online compiler, debugger and visualizer`,
    short_name: SITE.name,
    description: "Write, run, debug and share code in your browser: Java, Python, C, C++, JavaScript, Go, Rust, C#, HTML and more.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f8fa",
    theme_color: "#f7f8fa",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
