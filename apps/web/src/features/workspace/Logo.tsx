import { PRODUCT } from "@cw/shared";
import { cn } from "@/lib/cn";

/** Product mark: the W tile (public/logo.png, made from brand/ by scripts/make-icons.mjs). */
export function LogoMark({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a static export: next/image adds nothing for a tiny local icon
  return <img src="/logo.png" alt="" aria-hidden width={128} height={128} draggable={false} className={cn("size-5 shrink-0 select-none", className)} />;
}

/**
 * The brand as it appears in a header: the W tile in a ring of light, and the
 * name with "Code" in the brand gradient. Hovering sweeps a sheen over the
 * tile and shows a caret after the name, as if it had just been typed.
 * `name={false}` shows the tile alone (phones).
 */
export function Brand({ name = true, className }: { name?: boolean; className?: string }) {
  // "WriteCode" -> "Write" + "Code"; any other name is shown whole.
  const split = /^(.*[a-z])([A-Z][a-z]+)$/.exec(PRODUCT.name);
  return (
    <span className={cn("cw-brand flex items-center gap-2.5", className)}>
      <span className="cw-brand-mark">
        <LogoMark className="size-[26px]" />
      </span>
      {name && (
        <span className="cw-brand-name text-[16px] leading-none text-fg">
          {split ? (
            <>
              {split[1]}
              <span className="cw-brand-accent">{split[2]}</span>
            </>
          ) : (
            PRODUCT.name
          )}
          <span aria-hidden className="cw-brand-caret" />
        </span>
      )}
    </span>
  );
}

export function Logo() {
  return <Brand />;
}
