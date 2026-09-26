import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent", className)}
    />
  );
}

/** Uppercase section label used at the top of side panels. */
export function PanelHeader({ title, actions, className }: { title: string; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-9 shrink-0 items-center justify-between gap-2 pl-3 pr-1.5", className)}>
      <h2 className="truncate text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">{title}</h2>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-2 p-6 text-center", className)}>
      {icon && <div className="text-fg-faint [&_svg]:size-5">{icon}</div>}
      <p className="text-sm text-fg-muted">{title}</p>
      {description && <p className="max-w-64 text-xs text-fg-subtle">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-7 w-full rounded-md border border-line bg-surface px-2 text-sm text-fg placeholder:text-fg-faint",
        "outline-none transition-colors focus:border-accent-line focus:ring-2 focus:ring-accent-soft",
        "aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
});
