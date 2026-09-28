"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command as Cmdk } from "cmdk";
import { FolderGit2 } from "lucide-react";
import { useState } from "react";
import { getLanguage } from "@cw/shared";
import { Kbd } from "@/components/ui/kbd";
import { FileIcon } from "@/features/explorer/file-icon";
import { useWorkspace } from "@/features/projects/store";
import { useUI, type PaletteMode } from "@/features/workspace/ui-store";
import { COMMANDS, isEnabled } from "./registry";

const placeholders: Record<PaletteMode, string> = {
  commands: "Type a command…",
  files: "Search files by name…",
  projects: "Open a project…",
};

const itemClass =
  "flex h-7 cursor-default select-none items-center gap-2.5 rounded-[4px] px-2 text-sm text-fg data-[selected=true]:bg-accent-soft data-[disabled=true]:opacity-40";

export function CommandPalette() {
  const { open, mode } = useUI((s) => s.palette);
  const closePalette = useUI((s) => s.closePalette);
  const openPalette = useUI((s) => s.openPalette);
  const project = useWorkspace((s) => s.project);
  const projects = useWorkspace((s) => s.projects);
  const [search, setSearch] = useState("");

  // Every palette session starts empty; mode switches (">") keep what was typed.
  const close = () => {
    setSearch("");
    closePalette();
  };

  // Typing ">" in file mode switches to commands, like most editors.
  const onValueChange = (v: string) => {
    if (mode === "files" && v.startsWith(">")) {
      openPalette("commands");
      setSearch(v.slice(1));
      return;
    }
    setSearch(v);
  };

  const exec = (fn: () => void) => {
    close();
    // Let the dialog release focus before the command moves it (e.g. into Monaco).
    requestAnimationFrame(fn);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 animate-fade" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-lg bg-overlay shadow-float animate-pop"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Cmdk loop label="Command palette" className="flex flex-col">
            <Cmdk.Input
              value={search}
              onValueChange={onValueChange}
              placeholder={placeholders[mode]}
              className="h-10 border-b border-line-strong bg-transparent px-3 text-base text-fg outline-none placeholder:text-fg-subtle"
            />
            <Cmdk.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
              <Cmdk.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">No matches.</Cmdk.Empty>

              {mode === "commands" &&
                (["Run", "Debug", "Test", "AI", "File", "Edit", "Go", "View", "Project", "Preferences"] as const).map((category) => (
                  <Cmdk.Group
                    key={category}
                    heading={category}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-subtle"
                  >
                    {COMMANDS.filter((c) => c.category === category).map((c) => (
                      <Cmdk.Item
                        key={c.id}
                        value={`${c.category}: ${c.title}`}
                        disabled={!isEnabled(c)}
                        onSelect={() => exec(c.run)}
                        className={itemClass}
                      >
                        <span className="flex-1 truncate">
                          <span className="text-fg-subtle">{c.category}: </span>
                          {c.title}
                        </span>
                        {c.shortcut && <Kbd shortcut={c.shortcut.split(" / ")[0]!} />}
                      </Cmdk.Item>
                    ))}
                  </Cmdk.Group>
                ))}

              {mode === "files" &&
                project?.files.map((f) => (
                  <Cmdk.Item
                    key={f.path}
                    value={f.path}
                    onSelect={() => exec(() => useWorkspace.getState().openFile(f.path))}
                    className={itemClass}
                  >
                    <FileIcon name={f.path} />
                    <span className="truncate text-fg">{f.path.split("/").pop()}</span>
                    <span className="truncate text-xs text-fg-subtle">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                  </Cmdk.Item>
                ))}

              {mode === "projects" &&
                projects.map((p) => (
                  <Cmdk.Item
                    key={p.id}
                    value={`${p.name} ${p.id}`}
                    onSelect={() => exec(() => void useWorkspace.getState().openProject(p.id))}
                    className={itemClass}
                  >
                    <FolderGit2 className="size-3.5 text-fg-subtle" />
                    <span className="truncate text-fg">{p.name}</span>
                    <span className="ml-auto text-xs text-fg-subtle">{getLanguage(p.language)?.name}</span>
                  </Cmdk.Item>
                ))}
            </Cmdk.List>
            {mode === "files" && (
              <div className="flex h-7 items-center border-t border-line-strong px-3 text-xs text-fg-subtle">Type &gt; to search actions</div>
            )}
          </Cmdk>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
