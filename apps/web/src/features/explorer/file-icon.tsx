import { File, FileCode2, FileJson, FileText, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";

/** Muted per-language tints; icons stay monochrome-ish so the tree reads calmly. */
const TINTS: Record<string, string> = {
  java: "text-[#e76f51]",
  py: "text-[#6fa8dc]",
  cpp: "text-[#7c9ee6]",
  cc: "text-[#7c9ee6]",
  cxx: "text-[#7c9ee6]",
  hpp: "text-[#a58fe0]",
  h: "text-[#a58fe0]",
  c: "text-[#8fa4c7]",
  js: "text-[#e5c07b]",
  mjs: "text-[#e5c07b]",
  cjs: "text-[#e5c07b]",
  ts: "text-[#5aa9e6]",
  mts: "text-[#5aa9e6]",
};

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const cls = cn("size-3.5 shrink-0", className);
  if (ext === "json") return <FileJson className={cn(cls, "text-[#cbcb41]")} />;
  if (ext === "md" || ext === "txt") return <FileText className={cn(cls, "text-fg-subtle")} />;
  if (TINTS[ext]) return <FileCode2 className={cn(cls, TINTS[ext])} />;
  return <File className={cn(cls, "text-fg-subtle")} />;
}

export function FolderIcon({ open, className }: { open: boolean; className?: string }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon className={cn("size-3.5 shrink-0 text-fg-subtle", className)} />;
}
