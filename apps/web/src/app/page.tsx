import { PRODUCT } from "@cw/shared";
import { HOME_FAQS, SITE } from "@/features/seo/pages";
import { WorkspaceShell } from "@/features/workspace/WorkspaceShell";

/** Tells search engines what the site is: a free web app, and its name. */
const STRUCTURED = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    // The name Google shows for the site, and other ways people write it.
    name: SITE.name,
    alternateName: ["Write Code", "writecode.in", "WriteCode online compiler"],
    url: `${SITE.url}/`,
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.name,
    url: `${SITE.url}/`,
    logo: `${SITE.url}/icon-512.png`,
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
  {
    // The questions answered on the page itself, under the start screen.
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: HOME_FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
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
