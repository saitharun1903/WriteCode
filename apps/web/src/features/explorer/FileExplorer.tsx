"use client";

import {
  ChevronRight,
  Copy,
  FilePlus2,
  FolderPlus,
  FolderUp,
  ListCollapse,
  Pencil,
  Play,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { basename, buildTree, isWithin, parentOf, validateName, type TreeNode } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ContextMenu, type MenuEntry } from "@/components/ui/menu";
import { EmptyState, PanelHeader } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { importFromDrop, importPicker } from "@/features/projects/ImportDialog";
import { useWorkspace } from "@/features/projects/store";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { FileIcon, FolderIcon } from "./file-icon";

const ROW_HEIGHT = 24;
const INDENT = 18;
const OVERSCAN = 8;

type Row =
  | { type: "node"; node: TreeNode; depth: number }
  | { type: "create"; dir: string; kind: "file" | "folder"; depth: number };

function flatten(nodes: TreeNode[], expanded: Set<string>, creating: { dir: string; kind: "file" | "folder" } | null): Row[] {
  const rows: Row[] = [];
  // The folder receiving a new item is always shown open, along with its ancestors.
  const forced = new Set<string>();
  for (let d = creating?.dir ?? ""; d; d = parentOf(d)) forced.add(d);
  const walk = (list: TreeNode[], depth: number, dir: string) => {
    if (creating && creating.dir === dir) rows.push({ type: "create", dir, kind: creating.kind, depth });
    for (const node of list) {
      rows.push({ type: "node", node, depth });
      if (node.kind === "folder" && (expanded.has(node.path) || forced.has(node.path))) walk(node.children, depth + 1, node.path);
    }
  };
  walk(nodes, 0, "");
  return rows;
}

function rowKey(row: Row) {
  return row.type === "node" ? row.node.path : `__create__:${row.dir}`;
}

export function FileExplorer({ title = "Project" }: { title?: string }) {
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  const ws = useWorkspace.getState;
  // Inline creation lives in the UI store so menus and the command palette can start it too.
  const creating = useUI((s) => s.pendingCreate);

  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => (project ? buildTree(project.files, project.folders) : []), [project]);
  const rows = useMemo(() => flatten(tree, expanded, creating), [tree, expanded, creating]);

  // Reveal the active file: expand its ancestors whenever it changes. Adjusting state
  // during render (instead of in an effect) avoids an extra paint with the old tree.
  const [revealed, setRevealed] = useState<string | null>(null);
  if (activeFile && activeFile !== revealed) {
    setRevealed(activeFile);
    const missing: string[] = [];
    for (let dir = parentOf(activeFile); dir; dir = parentOf(dir)) if (!expanded.has(dir)) missing.push(dir);
    if (missing.length) setExpanded(new Set([...expanded, ...missing]));
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function startCreate(dir: string, kind: "file" | "folder") {
    setRenaming(null);
    if (dir) setExpanded((prev) => new Set(prev).add(dir));
    useUI.getState().requestCreate(dir, kind);
  }

  const endCreate = () => useUI.getState().clearPendingCreate();

  function toggle(path: string, open?: boolean) {
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? !next.has(path);
      if (shouldOpen) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function activate(node: TreeNode) {
    setFocused(node.path);
    if (node.kind === "folder") toggle(node.path);
    else {
      ws().openFile(node.path);
      useUI.getState().setDrawer("none");
    }
  }

  function scrollIntoView(index: number) {
    const el = scrollRef.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }

  function onTreeKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (renaming || creating) return;
    const nodeRows = rows.filter((r): r is Extract<Row, { type: "node" }> => r.type === "node");
    if (nodeRows.length === 0) return;
    const idx = Math.max(0, nodeRows.findIndex((r) => r.node.path === focused));
    const current = nodeRows[idx]!;
    const move = (i: number) => {
      const target = nodeRows[Math.min(Math.max(i, 0), nodeRows.length - 1)]!;
      setFocused(target.node.path);
      scrollIntoView(rows.indexOf(target));
    };
    switch (e.key) {
      case "ArrowDown":
        move(focused ? idx + 1 : 0);
        break;
      case "ArrowUp":
        move(idx - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(nodeRows.length - 1);
        break;
      case "ArrowRight":
        if (current.node.kind === "folder") {
          if (!expanded.has(current.node.path)) toggle(current.node.path, true);
          else move(idx + 1);
        }
        break;
      case "ArrowLeft":
        if (current.node.kind === "folder" && expanded.has(current.node.path)) toggle(current.node.path, false);
        else {
          const parent = parentOf(current.node.path);
          if (parent) {
            setFocused(parent);
            scrollIntoView(rows.findIndex((r) => r.type === "node" && r.node.path === parent));
          }
        }
        break;
      case "Enter":
      case " ":
        activate(current.node);
        break;
      case "F2":
        setRenaming(current.node.path);
        break;
      case "Delete":
        setConfirmDelete(current.node.path);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function contextEntries(node: TreeNode | null): MenuEntry[] {
    const dir = node ? (node.kind === "folder" ? node.path : parentOf(node.path)) : "";
    const entries: MenuEntry[] = [
      { label: "New File", icon: <FilePlus2 />, onSelect: () => startCreate(dir, "file") },
      { label: "New Folder", icon: <FolderPlus />, onSelect: () => startCreate(dir, "folder") },
      { label: "Import Files…", icon: <Upload />, onSelect: () => importPicker.files?.() },
      { label: "Import Folder…", icon: <FolderUp />, onSelect: () => importPicker.folder?.() },
    ];
    if (!node) return entries;
    entries.push({ kind: "separator" });
    if (node.kind === "file") {
      entries.push({
        label: "Set as Entry File",
        icon: <Play />,
        disabled: project?.entryFile === node.path,
        onSelect: () => ws().setEntryFile(node.path),
      });
    }
    entries.push(
      { label: "Rename", icon: <Pencil />, shortcut: "F2", onSelect: () => setRenaming(node.path) },
      {
        label: "Copy Path",
        icon: <Copy />,
        onSelect: () =>
          navigator.clipboard.writeText(node.path).then(
            () => toast.info("Path copied", node.path),
            () => toast.error("Clipboard unavailable"),
          ),
      },
      { kind: "separator" },
      { label: "Delete", icon: <Trash2 />, shortcut: "Delete", danger: true, onSelect: () => setConfirmDelete(node.path) },
    );
    return entries;
  }

  if (!project) return null;

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const deleteTarget = confirmDelete;
  const deleteIsFolder = !!deleteTarget && !project.files.some((f) => f.path === deleteTarget);
  const deleteCount = deleteTarget ? project.files.filter((f) => isWithin(f.path, deleteTarget)).length : 0;

  const onDrop = (targetDir: string, e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const from = e.dataTransfer.getData("application/x-cw-path");
    if (!from || isWithin(targetDir, from) || parentOf(from) === targetDir) return;
    ws().movePath(from, targetDir);
    if (targetDir) toggle(targetDir, true);
  };

  // Files dragged in from the desktop (not a move inside the tree) are imported.
  const fromDesktop = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("application/x-cw-path");

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOverCapture={(e) => {
        if (!fromDesktop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setImporting(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setImporting(false);
      }}
      onDropCapture={(e) => {
        if (!fromDesktop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setImporting(false);
        importFromDrop(e.dataTransfer);
      }}
    >
      {importing && (
        <div className="pointer-events-none absolute inset-1.5 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent bg-accent-soft/40 text-sm text-fg">
          <Upload className="size-5 text-accent-ink" />
          Drop to import into the project
        </div>
      )}
      <PanelHeader
        title={title}
        actions={
          <>
            <IconButton label="New File" size="sm" onClick={() => startCreate("", "file")}>
              <FilePlus2 />
            </IconButton>
            <IconButton label="New Folder" size="sm" onClick={() => startCreate("", "folder")}>
              <FolderPlus />
            </IconButton>
            <IconButton label="Import Files" size="sm" onClick={() => importPicker.files?.()}>
              <Upload />
            </IconButton>
            <IconButton label="Collapse Folders" size="sm" onClick={() => setExpanded(new Set())}>
              <ListCollapse />
            </IconButton>
          </>
        }
      />
      <ContextMenu entries={contextEntries(null)}>
        <div
          ref={scrollRef}
          role="tree"
          aria-label="Project files"
          tabIndex={0}
          aria-activedescendant={focused ? `tree-${focused}` : undefined}
          onKeyDown={onTreeKeyDown}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("application/x-cw-path")) return;
            e.preventDefault();
            setDropTarget("");
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDropTarget(null);
          }}
          onDrop={(e) => onDrop("", e)}
          className={cn(
            "relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6 outline-none",
            dropTarget === "" && "bg-accent-soft/40",
          )}
        >
          {rows.length === 0 && (
            <EmptyState
              title="No files"
              action={
                <Button size="sm" icon={<FilePlus2 className="size-3.5" />} onClick={() => startCreate("", "file")}>
                  New file
                </Button>
              }
            />
          )}
          <div style={{ height: rows.length * ROW_HEIGHT }} className="relative">
            {rows.slice(start, end).map((row, i) => {
              const top = (start + i) * ROW_HEIGHT;
              if (row.type === "create") {
                return (
                  <div key={rowKey(row)} style={{ top, height: ROW_HEIGHT }} className="absolute inset-x-0">
                    <InlineName
                      depth={row.depth}
                      icon={row.kind === "folder" ? <FolderIcon open={false} /> : <FileIcon name="" />}
                      initial=""
                      onCommit={(name) => {
                        endCreate();
                        if (!name) return;
                        const created =
                          row.kind === "file" ? ws().createFile(row.dir, name) : ws().createFolder(row.dir, name);
                        if (created) setFocused(created);
                      }}
                      onCancel={() => endCreate()}
                    />
                  </div>
                );
              }
              const { node, depth } = row;
              const isOpen = node.kind === "folder" && expanded.has(node.path);
              if (renaming === node.path) {
                return (
                  <div key={rowKey(row)} style={{ top, height: ROW_HEIGHT }} className="absolute inset-x-0">
                    <InlineName
                      depth={depth}
                      icon={node.kind === "folder" ? <FolderIcon open={isOpen} /> : <FileIcon name={node.name} />}
                      initial={node.name}
                      onCommit={(name) => {
                        setRenaming(null);
                        if (!name || name === node.name) return;
                        const next = ws().renamePath(node.path, name);
                        if (next) setFocused(next);
                      }}
                      onCancel={() => setRenaming(null)}
                    />
                  </div>
                );
              }
              const dropDir = node.kind === "folder" ? node.path : parentOf(node.path);
              return (
                <ContextMenu key={rowKey(row)} entries={contextEntries(node)}>
                  <div
                    id={`tree-${node.path}`}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-expanded={node.kind === "folder" ? isOpen : undefined}
                    aria-selected={activeFile === node.path}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/x-cw-path", node.path);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes("application/x-cw-path")) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDropTarget(dropDir);
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      onDrop(dropDir, e);
                    }}
                    onClick={() => activate(node)}
                    onContextMenu={() => setFocused(node.path)}
                    style={{ top, height: ROW_HEIGHT, paddingLeft: 8 + depth * INDENT }}
                    className={cn(
                      "group absolute inset-x-1 flex items-center gap-1.5 rounded-[4px] pr-2 text-sm text-fg",
                      "hover:bg-hover",
                      activeFile === node.path && "bg-accent-soft hover:bg-accent-soft",
                      focused === node.path && "ring-1 ring-inset ring-accent",
                      dropTarget === dropDir && dropTarget !== "" && isWithin(node.path, dropDir) && "bg-accent-soft",
                    )}
                  >
                    {node.kind === "folder" ? (
                      <ChevronRight className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform duration-100", isOpen && "rotate-90")} />
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    {node.kind === "folder" ? <FolderIcon open={isOpen} /> : <FileIcon name={node.name} />}
                    <span className="truncate">{node.name}</span>
                    {project.entryFile === node.path && (
                      <span title="Entry file (run configuration)" className="ml-auto flex items-center text-success">
                        <Play className="size-3 fill-current" />
                      </span>
                    )}
                  </div>
                </ContextMenu>
              );
            })}
          </div>
        </div>
      </ContextMenu>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${deleteTarget ? basename(deleteTarget) : ""}?`}
        description={
          deleteIsFolder
            ? `This folder and ${deleteCount} file${deleteCount === 1 ? "" : "s"} inside it will be removed from the project.`
            : "This file will be removed from the project."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              autoFocus
              onClick={() => {
                if (deleteTarget) ws().deletePath(deleteTarget);
                setConfirmDelete(null);
                scrollRef.current?.focus();
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-xs text-fg-subtle">Tip: save a snapshot first if you may want this back.</p>
      </Dialog>
    </div>
  );
}

function InlineName({
  depth,
  icon,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  icon: React.ReactNode;
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const error = value ? validateName(value) : null;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the stem so typing replaces the name but keeps the extension.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = () => {
    if (done.current) return;
    if (error) return;
    done.current = true;
    onCommit(value.trim());
  };

  return (
    <div className="relative flex h-full items-center gap-1.5 pr-2" style={{ paddingLeft: 8 + depth * INDENT + 12 + 6 }}>
      {icon}
      <input
        ref={inputRef}
        value={value}
        aria-label="Name"
        aria-invalid={!!error}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (error || !value.trim()) {
            done.current = true;
            onCancel();
          } else commit();
        }}
        className={cn(
          "h-5 min-w-0 flex-1 rounded-sm border border-accent-line bg-surface-2 px-1 text-sm text-fg outline-none",
          error && "border-danger",
        )}
      />
      {error && (
        <div className="absolute left-6 right-2 top-full z-10 rounded-sm border border-danger bg-overlay px-2 py-1 text-xs text-danger shadow-float">
          {error}
        </div>
      )}
    </div>
  );
}
