import type { MetadataRoute } from "next";
import { LANDING_PAGES, SITE } from "@/features/seo/pages";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: SITE.url, lastModified: now, changeFrequency: "weekly", priority: 1 },
    ...LANDING_PAGES.map((p) => ({
      url: `${SITE.url}/${p.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: p.kind === "language" ? 0.9 : 0.8,
    })),
  ];
}
