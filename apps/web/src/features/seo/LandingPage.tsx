import Link from "next/link";
import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { Brand, LogoMark } from "@/features/workspace/Logo";
import { LANDING_PAGES, SITE, type LandingPage as Page } from "./pages";

const languages = LANDING_PAGES.filter((p) => p.kind === "language");
const tools = LANDING_PAGES.filter((p) => p.kind === "feature");

/** Structured data: what the page is (a free web app), its questions and answers, and where it sits. */
function jsonLd(page: Page) {
  const url = `${SITE.url}/${page.slug}`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: `${SITE.name}: ${page.h1}`,
      url,
      description: page.description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any (runs in the browser)",
      offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE.name, item: SITE.url },
        { "@type": "ListItem", position: 2, name: page.h1, item: url },
      ],
    },
  ];
}

function CodeCard({ file, code }: Page["sample"]) {
  const lines = code.split("\n");
  return (
    <figure className="overflow-hidden rounded-xl border border-line-strong/70 bg-surface-2 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.55)]">
      <figcaption className="flex items-center gap-2 border-b border-line-strong/60 px-4 py-2.5 text-xs text-fg-subtle">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="ml-2 font-medium text-fg-muted">{file}</span>
      </figcaption>
      <pre className="overflow-x-auto py-3 font-mono text-[12.5px] leading-[1.7] [font-variant-ligatures:none]">
        <code>
          {lines.map((line, i) => (
            <span key={i} className="flex">
              <span aria-hidden className="w-10 shrink-0 select-none pr-3 text-right text-fg-faint">
                {i + 1}
              </span>
              <span className="whitespace-pre pr-4 text-fg">{line || " "}</span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

function OpenButton({ page, large }: { page: Page; large?: boolean }) {
  return (
    <a
      href={`/?new=${page.language}`}
      className={
        large
          ? "inline-flex h-11 items-center gap-2 rounded-lg bg-gradient-to-b from-[#29a35d] to-[#1f8f4e] px-5 text-[15px] font-semibold text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.98]"
          : "inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg hover:brightness-110"
      }
    >
      {page.cta} <ArrowRight className={large ? "size-4" : "size-3.5"} />
    </a>
  );
}

export function LandingPage({ page }: { page: Page }) {
  return (
    // The IDE fixes the page height; landing pages scroll inside their own container.
    <div className="h-dvh overflow-y-auto bg-canvas text-fg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(page)) }} />
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link href="/" aria-label={SITE.name} className="flex items-center">
            <Brand />
          </Link>
          <ul className="ml-4 hidden items-center gap-1 text-[13px] text-fg-muted md:flex">
            {tools
              .filter((t) => t.slug !== "online-compiler")
              .map((t) => (
                <li key={t.slug}>
                  <Link href={`/${t.slug}`} className="rounded-md px-2.5 py-1.5 hover:bg-hover hover:text-fg" aria-current={t.slug === page.slug ? "page" : undefined}>
                    {t.label}
                  </Link>
                </li>
              ))}
          </ul>
          <span className="ml-auto">
            <OpenButton page={{ ...page, cta: "Open editor" }} />
          </span>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-14 pt-12 md:grid-cols-[1.05fr_1fr] md:pt-20">
          <div>
            <p className="mb-3 text-[13px] font-medium uppercase tracking-[0.08em] text-accent">{SITE.tagline}</p>
            <h1 className="text-[34px] font-bold leading-[1.1] tracking-tight md:text-[46px]">{page.h1}</h1>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-fg-muted">{page.intro}</p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <OpenButton page={page} large />
            </div>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-fg-subtle">
              {["Free", "No sign-up", "Real compilers", "Works on phones"].map((f) => (
                <li key={f} className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-success" /> {f}
                </li>
              ))}
            </ul>
          </div>
          <CodeCard {...page.sample} />
        </section>

        <section aria-labelledby="features" className="border-t border-line bg-surface-2/40">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 id="features" className="text-2xl font-bold tracking-tight">
              What you can do
            </h2>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {page.features.map((f) => (
                <li key={f.title} className="rounded-xl border border-line-strong/60 bg-canvas p-5">
                  <h3 className="font-semibold">{f.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">{f.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="how" className="mx-auto max-w-6xl px-4 py-16">
          <h2 id="how" className="text-2xl font-bold tracking-tight">
            How it works
          </h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-2">
            {page.steps.map((s, i) => (
              <li key={s} className="flex gap-4 rounded-xl border border-line-strong/60 p-5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">{i + 1}</span>
                <p className="text-[14.5px] leading-relaxed text-fg-muted">{s}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8">
            <OpenButton page={page} large />
          </div>
        </section>

        <section aria-labelledby="faq" className="border-t border-line bg-surface-2/40">
          <div className="mx-auto max-w-3xl px-4 py-16">
            <h2 id="faq" className="text-2xl font-bold tracking-tight">
              Questions and answers
            </h2>
            <div className="mt-6 divide-y divide-line-strong/60 rounded-xl border border-line-strong/60 bg-canvas">
              {page.faqs.map((f) => (
                <details key={f.q} className="group px-5 py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                    {f.q}
                    <ChevronDown className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-fg-muted">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="more" className="mx-auto max-w-6xl px-4 py-16">
          <h2 id="more" className="text-2xl font-bold tracking-tight">
            Compilers and tools
          </h2>
          <div className="mt-6 grid gap-8 md:grid-cols-2">
            <ul className="grid grid-cols-2 gap-2">
              {languages.map((p) => (
                <li key={p.slug}>
                  <Link href={`/${p.slug}`} className="block rounded-lg border border-line-strong/60 px-4 py-3 text-[14px] hover:border-accent/60 hover:bg-hover">
                    Online {p.label}
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="grid grid-cols-2 gap-2">
              {tools.map((p) => (
                <li key={p.slug}>
                  <Link href={`/${p.slug}`} className="block rounded-lg border border-line-strong/60 px-4 py-3 text-[14px] hover:border-accent/60 hover:bg-hover">
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-[13px] text-fg-subtle">
          <span className="flex items-center gap-2 font-semibold text-fg">
            <LogoMark className="size-5" /> {SITE.name}
          </span>
          <span>Write, run, debug and share code in your browser.</span>
          <Link href="/" className="ml-auto hover:text-fg">
            Open the editor
          </Link>
        </div>
      </footer>
    </div>
  );
}
