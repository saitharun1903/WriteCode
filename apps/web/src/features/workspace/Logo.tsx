import { PRODUCT } from "@cw/shared";
import { cn } from "@/lib/cn";

/** Product mark: a bracketed cursor on a solid tile. Kept geometric so it survives any rename. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={cn("size-5", className)}>
      <rect width="20" height="20" rx="4.5" fill="#3574f0" />
      <path d="M8 6 4.75 10 8 14" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="10" y="12.4" width="5.6" height="1.8" rx="0.9" fill="#fff" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="text-sm font-semibold text-fg">{PRODUCT.name}</span>
    </span>
  );
}
