"use client";

import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
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
      checked?: boolean;
      onSelect: () => void;
    }
  | { kind: "submenu"; label: string; icon?: ReactNode; entries: MenuEntry[] }
  | { kind: "separator" }
  | { kind: "label"; label: string };

const contentClass = "z-50 min-w-52 overflow-hidden rounded-lg bg-overlay p-1 text-sm text-fg shadow-float animate-pop";
const itemClass = cn(
  "relative flex h-[26px] select-none items-center gap-2 rounded-[4px] px-2 outline-none",
  "data-[highlighted]:bg-accent-soft data-[state=open]:bg-accent-soft data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:text-fg-subtle",
);

/** Touch screens: rows tall enough for a finger. */
const touchItemClass = "h-10 gap-3 rounded-md px-2.5 text-[15px] [&_svg]:size-[18px]";

type Primitives = typeof DropdownPrimitive | typeof ContextMenuPrimitive;

interface Look {
  /** Finger-sized rows. */
  touch?: boolean;
  /** Submenus open in place, under their row, instead of beside the menu (where a phone has no room). */
  inline?: boolean;
}

/** A submenu that opens in place: its row stays, its items appear under it. */
function InlineSub({ P, entry, markSelected, look }: { P: Primitives; entry: Extract<MenuEntry, { kind: "submenu" }>; markSelected: () => void; look: Look }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <P.Item
        aria-expanded={open}
        // Opening a section keeps the menu open.
        onSelect={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        className={cn(itemClass, look.touch && touchItemClass)}
      >
        <span className="flex w-4 justify-center">{entry.icon}</span>
        <span className="flex-1 truncate">{entry.label}</span>
        <ChevronRight className={cn("-mr-0.5 transition-transform", open && "rotate-90")} />
      </P.Item>
      {open && <div className="mb-1 ml-4 border-l border-line-strong/70 pl-1">{renderEntries(P, entry.entries, markSelected, look)}</div>}
    </>
  );
}

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

function renderEntries(P: Primitives, entries: MenuEntry[], markSelected: () => void, look: Look = {}): ReactNode[] {
  return entries.map((entry, i) => {
    if (entry.kind === "separator") return <P.Separator key={i} className="-mx-1 my-1 h-px bg-line-strong" />;
    if (entry.kind === "label")
      return (
        <P.Label key={i} className="px-2 pb-1 pt-1.5 text-xs text-fg-subtle">
          {entry.label}
        </P.Label>
      );
    if (entry.kind === "submenu") {
      if (look.inline) return <InlineSub key={i} P={P} entry={entry} markSelected={markSelected} look={look} />;
      return (
        <P.Sub key={i}>
          <P.SubTrigger className={cn(itemClass, look.touch && touchItemClass)}>
            <span className="flex w-4 justify-center">{entry.icon}</span>
            <span className="flex-1 truncate">{entry.label}</span>
            <ChevronRight className="-mr-0.5" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent sideOffset={6} alignOffset={-4} collisionPadding={8} className={cn(contentClass, "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto")}>
              {renderEntries(P, entry.entries, markSelected, look)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    }
    return (
      <P.Item
        key={i}
        disabled={entry.disabled}
        onSelect={() => {
          markSelected();
          entry.onSelect();
        }}
        className={cn(itemClass, look.touch && touchItemClass, entry.danger && "text-danger [&_svg]:text-danger")}
      >
        <span className="flex w-4 justify-center">{entry.checked ? <Check className="!text-fg" /> : entry.icon}</span>
        <span className="flex-1 truncate">{entry.label}</span>
        {entry.shortcut && <Kbd shortcut={entry.shortcut} className="ml-6" />}
      </P.Item>
    );
  });
}

interface DropdownMenuProps {
  trigger: ReactNode;
  entries: MenuEntry[];
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  /** Touch screens: finger-sized rows. */
  touch?: boolean;
  /** Phones: submenus open in place. */
  inline?: boolean;
}

export function DropdownMenu({ trigger, entries, align = "start", side = "bottom", touch, inline }: DropdownMenuProps) {
  const guard = useSelectionFocusGuard();
  return (
    <DropdownPrimitive.Root modal={false}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          // Never taller than the screen: a long menu scrolls.
          className={cn(contentClass, "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto", touch && "min-w-60 p-1.5")}
          onCloseAutoFocus={guard.onCloseAutoFocus}
        >
          {renderEntries(DropdownPrimitive, entries, guard.markSelected, { touch, inline })}
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
