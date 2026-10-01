"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95",
  secondary: "border border-line-strong text-fg hover:bg-hover active:bg-active",
  ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-active",
  danger: "bg-danger text-white hover:brightness-110",
};

const sizes: Record<Size, string> = {
  // On a touch screen (`data-touch` on <html>) buttons are a finger tall.
  sm: "h-6 px-2 gap-1.5 text-xs [[data-touch]_&]:h-8 [[data-touch]_&]:px-3 [[data-touch]_&]:text-[13px]",
  md: "h-7 px-3 gap-1.5 text-sm [[data-touch]_&]:h-9 [[data-touch]_&]:px-4 [[data-touch]_&]:text-[14px] [[data-touch]_&]:rounded-[8px]",
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
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-[4px] transition-[background-color,color,filter] duration-75",
        "disabled:pointer-events-none disabled:opacity-40",
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
          "inline-flex shrink-0 items-center justify-center rounded-[5px] text-fg-muted transition-colors duration-75",
          "hover:bg-hover active:bg-active disabled:pointer-events-none disabled:opacity-35",
          size === "sm" ? "size-6 [&_svg]:size-3.5 [[data-touch]_&]:size-8 [[data-touch]_&]:[&_svg]:size-4" : "size-7 [&_svg]:size-4 [[data-touch]_&]:size-9 [[data-touch]_&]:[&_svg]:size-[18px]",
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
