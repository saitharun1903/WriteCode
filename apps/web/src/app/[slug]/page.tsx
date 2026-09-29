import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LandingPage } from "@/features/seo/LandingPage";
import { LANDING_PAGES, SITE, pageBySlug } from "@/features/seo/pages";

// Only the listed pages exist; they are built as static HTML.
export const dynamicParams = false;

export function generateStaticParams() {
  return LANDING_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/[slug]">): Promise<Metadata> {
  const page = pageBySlug((await params).slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: `/${page.slug}` },
    openGraph: { title: `${page.title} | ${SITE.name}`, description: page.description, url: `/${page.slug}`, type: "website" },
  };
}

export default async function Page({ params }: PageProps<"/[slug]">) {
  const page = pageBySlug((await params).slug);
  if (!page) notFound();
  return <LandingPage page={page} />;
}
