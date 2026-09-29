import type { MetadataRoute } from "next";
import { SITE } from "@/features/seo/pages";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    // Live session pages are private to the people with the link.
    rules: { userAgent: "*", allow: "/", disallow: ["/live", "/api/"] },
    sitemap: `${SITE.url}/sitemap.xml`,
    host: SITE.url,
  };
}
