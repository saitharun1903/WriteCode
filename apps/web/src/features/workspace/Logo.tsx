import { PRODUCT } from "@cw/shared";
import { cn } from "@/lib/cn";

/**
 * Product mark: a white W on a rounded tile in the brand's blue-to-violet.
 * Drawn, not a picture, so it is sharp at every size and in both themes.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-5 shrink-0 select-none", className)}>
      <defs>
        <linearGradient id="cw-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f7dff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill="url(#cw-mark)" />
      <path d="M8 10.5 12 21.5 16 13 20 21.5 24 10.5" fill="none" stroke="#fff" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The brand as it appears in a header: the mark, and the name as one quiet
 * wordmark ("Write" strong, "Code" lighter). `name={false}` shows the mark
 * alone (phones).
 */
export function Brand({ name = true, className }: { name?: boolean; className?: string }) {
  // "WriteCode" -> "Write" + "Code"; any other name is shown whole.
  const split = /^(.*[a-z])([A-Z][a-z]+)$/.exec(PRODUCT.name);
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className="size-[26px]" />
      {name && (
        <span className="text-[16px] font-semibold leading-none tracking-[-0.02em] text-fg">
          {split ? (
            <>
              {split[1]}
              <span className="font-normal text-fg-muted">{split[2]}</span>
            </>
          ) : (
            PRODUCT.name
          )}
        </span>
      )}
    </span>
  );
}

export function Logo() {
  return <Brand />;
}
