import { PRODUCT } from "@cw/shared";
import { cn } from "@/lib/cn";

/**
 * Product mark: a W set in pixels on a dark tile, with the cursor waiting
 * under it (the same drawing as brand/writecode-mark.svg, which the icons are
 * made from). It is drawn on a 16 x 16 grid, so sizes that are a multiple of
 * 8 keep every pixel sharp.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-5 shrink-0 select-none", className)}>
      <rect width="16" height="16" rx="3" fill="#15161a" />
      {/* A hairline, so the dark tile keeps its edge on a dark bar. */}
      <rect x="0.25" y="0.25" width="15.5" height="15.5" rx="2.75" fill="none" stroke="#fff" strokeOpacity="0.16" strokeWidth="0.5" />
      <path fill="#f4efe4" d="M3 2h2v8H3zM11 2h2v8h-2zM7 6h2v4H7zM5 10h2v2H5zM9 10h2v2H9z" />
      <rect x="3" y="13" width="4" height="1.25" fill="#ffb224" />
    </svg>
  );
}

/**
 * The brand as it appears in a header: the mark, and the name in the
 * fixed-width face of a terminal. `name={false}` shows the mark alone (phones).
 */
export function Brand({ name = true, className }: { name?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className="size-6" />
      {name && (
        // Always the same face, whatever code font is chosen in Settings.
        <span className="text-[15.5px] font-bold leading-none tracking-[-0.03em] text-fg" style={{ fontFamily: 'var(--font-code-jetbrains), "Cascadia Mono", Consolas, monospace' }}>
          {PRODUCT.name}
        </span>
      )}
    </span>
  );
}

export function Logo() {
  return <Brand />;
}
