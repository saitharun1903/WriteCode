import { PRODUCT } from "@cw/shared";
import { cn } from "@/lib/cn";

/** Product mark: the W tile (public/logo.png, made from brand/ by scripts/make-icons.mjs). */
export function LogoMark({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a static export: next/image adds nothing for a tiny local icon
  return <img src="/logo.png" alt="" aria-hidden width={128} height={128} draggable={false} className={cn("size-5 shrink-0 select-none", className)} />;
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="text-sm font-semibold text-fg">{PRODUCT.name}</span>
    </span>
  );
}
