"use client";

import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Kbd } from "./kbd";

/**
 * One menu model for dropdowns and context menus so both look and behave
 * identically. Items are data; the renderer picks the Radix primitive.
 */
export type MenuEntry =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator" }
  | { kind: "label"; label: string };

const contentClass =
  "z-50 min-w-48 overflow-hidden rounded-md border border-line bg-overlay p-1 text-sm text-fg shadow-float animate-pop";
const itemClass = cn(
  "relative flex h-7 select-none items-center gap-2 rounded-sm px-2 outline-none",
  "data-[highlighted]:bg-active data-[disabled]:opacity-40 [&_svg]:size-3.5 [&_svg]:text-fg-subtle",
);

type Primitives = typeof DropdownPrimitive | typeof ContextMenuPrimitive;

/**
 * Radix returns focus to the trigger when a menu closes. That is right for
 * Escape, but wrong after choosing an item that moves focus itself (e.g.
 * "Rename" focusing an inline input), so skip the restore in that case.
 */
function useSelectionFocusGuard() {
  const selected = useRef(false);
  return {
    markSelected: () => {
      selected.current = true;
    },
    onCloseAutoFocus: (e: Event) => {
      if (selected.current) e.preventDefault();
      selected.current = false;
    },
  };
}

function renderEntries(P: Primitives, entries: MenuEntry[], markSelected: () => void) {
  return entries.map((entry, i) => {
    if (entry.kind === "separator") return <P.Separator key={i} className="-mx-1 my-1 h-px bg-line" />;
    if (entry.kind === "label")
      return (
        <P.Label key={i} className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-fg-subtle">
          {entry.label}
        </P.Label>
      );
    return (
      <P.Item
        key={i}
        disabled={entry.disabled}
        onSelect={() => {
          markSelected();
          entry.onSelect();
        }}
        className={cn(itemClass, entry.danger && "text-danger [&_svg]:text-danger")}
      >
        <span className="flex w-4 justify-center">{entry.icon}</span>
        <span className="flex-1 truncate">{entry.label}</span>
        {entry.shortcut && <Kbd shortcut={entry.shortcut} className="ml-4" />}
      </P.Item>
    );
  });
}

interface DropdownMenuProps {
  trigger: ReactNode;
  entries: MenuEntry[];
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}

export function DropdownMenu({ trigger, entries, align = "start", side = "bottom" }: DropdownMenuProps) {
  const guard = useSelectionFocusGuard();
  return (
    <DropdownPrimitive.Root modal={false}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content align={align} side={side} sideOffset={4} className={contentClass} onCloseAutoFocus={guard.onCloseAutoFocus}>
          {renderEntries(DropdownPrimitive, entries, guard.markSelected)}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

interface ContextMenuProps {
  entries: MenuEntry[];
  children: ReactNode;
}

export function ContextMenu({ entries, children }: ContextMenuProps) {
  const guard = useSelectionFocusGuard();
  return (
    <ContextMenuPrimitive.Root modal={false}>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={contentClass} onCloseAutoFocus={guard.onCloseAutoFocus}>
          {renderEntries(ContextMenuPrimitive, entries, guard.markSelected)}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
