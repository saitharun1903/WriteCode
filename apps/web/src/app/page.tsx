import { PRODUCT } from "@cw/shared";
import { SITE } from "@/features/seo/pages";
import { WorkspaceShell } from "@/features/workspace/WorkspaceShell";

/** Tells search engines what the site is: a free web app, and its name. */
const STRUCTURED = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: SITE.url,
  },
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: SITE.name,
    url: SITE.url,
    description: PRODUCT.description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any (runs in the browser)",
    offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
    featureList: ["Online compiler", "Debugger", "Code visualizer", "Test cases", "Live collaboration", "AI assistant"],
  },
];

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED) }} />
      <WorkspaceShell />
    </>
  );
}
