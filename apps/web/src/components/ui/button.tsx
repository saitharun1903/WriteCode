"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95 font-medium",
  secondary: "bg-surface-3 text-fg border border-line hover:border-line-strong hover:bg-active",
  ghost: "text-fg-muted hover:text-fg hover:bg-hover active:bg-active",
  danger: "bg-danger-soft text-danger hover:bg-danger hover:text-white",
};

const sizes: Record<Size, string> = {
  sm: "h-6 px-2 gap-1.5 text-xs rounded-sm",
  md: "h-7 px-2.5 gap-1.5 text-sm rounded-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap transition-[background-color,color,filter,border-color] duration-100",
        "disabled:pointer-events-none disabled:opacity-45",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  shortcut?: string;
  size?: "sm" | "md";
  active?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, size = "md", active, className, children, tooltipSide = "bottom", type = "button", ...props },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors duration-100",
          "hover:bg-hover hover:text-fg active:bg-active disabled:pointer-events-none disabled:opacity-40",
          size === "sm" ? "size-5 [&_svg]:size-3.5" : "size-7 [&_svg]:size-4",
          active && "bg-active text-fg",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});
