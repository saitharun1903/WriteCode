import Link from "next/link";
import { LogoMark } from "@/features/workspace/Logo";
import { SITE } from "@/features/seo/pages";

/** Where people write to about the site: privacy questions, terms, faults, abuse. */
export const SUPPORT_EMAIL = "support@writecode.in";

export type LegalSection = { h: string; p: string[] };

/** A plain reading page for the privacy notice and the terms of use. */
export function LegalPage({ title, intro, updated, sections }: { title: string; intro: string; updated: string; sections: LegalSection[] }) {
  return (
    <div className="min-h-screen bg-surface-2">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-fg">
            <LogoMark className="size-6" /> {SITE.name}
          </Link>
          <nav aria-label="Legal" className="ml-auto flex gap-4 text-[13px] text-fg-subtle">
            <Link href="/privacy" className="hover:text-fg">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-fg">
              Terms
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-[30px] font-bold tracking-tight text-fg">{title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">{intro}</p>
        <p className="mt-1 text-[13px] text-fg-subtle">Last updated {updated}</p>
        {sections.map((s) => (
          <section key={s.h} className="mt-8">
            <h2 className="text-lg font-semibold text-fg">{s.h}</h2>
            {s.p.map((t, i) => (
              <p key={i} className="mt-2 text-[15px] leading-relaxed text-fg-muted">
                {t}
              </p>
            ))}
          </section>
        ))}
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-fg">Contact</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">
            Questions, requests or a problem to report: write to{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-accent-ink hover:underline">
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </section>
        <p className="mt-10 text-[13px] text-fg-subtle">
          <Link href="/" className="text-accent-ink hover:underline">
            Back to the editor
          </Link>
        </p>
      </main>
    </div>
  );
}
