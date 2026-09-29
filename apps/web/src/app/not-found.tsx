import Link from "next/link";
import { LogoMark } from "@/features/workspace/Logo";
import { LANDING_PAGES } from "@/features/seo/pages";

export default function NotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-5 overflow-y-auto bg-canvas px-4 text-center text-fg">
      <LogoMark className="size-10" />
      <h1 className="text-2xl font-bold tracking-tight">This page does not exist</h1>
      <p className="max-w-md text-fg-muted">The link may be mistyped or old. Start coding, or pick a compiler:</p>
      <Link href="/" className="rounded-lg bg-accent px-4 py-2 font-semibold text-accent-fg hover:brightness-110">
        Open the editor
      </Link>
      <ul className="flex max-w-xl flex-wrap justify-center gap-x-4 gap-y-2 text-[13px] text-fg-subtle">
        {LANDING_PAGES.map((p) => (
          <li key={p.slug}>
            <Link href={`/${p.slug}`} className="hover:text-fg hover:underline">
              {p.kind === "language" ? `Online ${p.label}` : p.label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
