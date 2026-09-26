"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, className }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 animate-fade" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-[16vh] z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 rounded-lg bg-overlay shadow-float animate-pop",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-4 pb-2 pt-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-fg">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-fg-muted">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-mr-1 -mt-1 rounded-sm p-1 text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="px-4 pb-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 px-4 pb-4 pt-1">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
