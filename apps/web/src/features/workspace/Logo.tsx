import { PRODUCT } from "@cw/shared";
import { cn } from "@/lib/cn";

/** Product mark: a bracketed cursor. Kept geometric so it survives any rename. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={cn("size-5", className)}>
      <rect x="0.75" y="0.75" width="18.5" height="18.5" rx="5" className="fill-surface-3 stroke-line-strong" strokeWidth="1.5" />
      <path d="M7.5 6.5 4.75 10l2.75 3.5" className="stroke-fg-muted" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="10" y="12.2" width="5.2" height="1.6" rx="0.8" className="fill-accent" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="text-sm font-semibold tracking-tight text-fg">{PRODUCT.name}</span>
    </span>
  );
}
