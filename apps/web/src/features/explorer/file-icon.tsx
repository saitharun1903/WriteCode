import { Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Compact file-type glyphs in the style of desktop IDE file icons: a class
 * marker for Java sources, and a document with a coloured type tag for the rest.
 */

const TAGS: Record<string, { text: string; color: string }> = {
  py: { text: "PY", color: "#3d8fd6" },
  cpp: { text: "C++", color: "#5b8dd9" },
  cc: { text: "C++", color: "#5b8dd9" },
  cxx: { text: "C++", color: "#5b8dd9" },
  hpp: { text: "H", color: "#9b7fd9" },
  h: { text: "H", color: "#9b7fd9" },
  c: { text: "C", color: "#6e8fb8" },
  js: { text: "JS", color: "#c9a227" },
  mjs: { text: "JS", color: "#c9a227" },
  cjs: { text: "JS", color: "#c9a227" },
  ts: { text: "TS", color: "#3178c6" },
  mts: { text: "TS", color: "#3178c6" },
  html: { text: "<>", color: "#e0703a" },
  htm: { text: "<>", color: "#e0703a" },
  css: { text: "CSS", color: "#3f7fd9" },
  kt: { text: "KT", color: "#8a63e6" },
  go: { text: "GO", color: "#29a8c9" },
  rs: { text: "RS", color: "#c0703a" },
  cs: { text: "C#", color: "#8a5cc7" },
  php: { text: "PHP", color: "#7a86c4" },
  rb: { text: "RB", color: "#cc4b45" },
  sql: { text: "SQL", color: "#3f8fb0" },
  sh: { text: "SH", color: "#5f9e52" },
  json: { text: "{}", color: "#b3ae60" },
  md: { text: "MD", color: "#7c8591" },
};

function extOf(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const ext = extOf(name);
  const cls = cn("size-4 shrink-0", className);

  if (ext === "java") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className={cls}>
        <circle cx="8" cy="8" r="6.5" fill="#548af7" fillOpacity="0.16" stroke="#548af7" strokeWidth="1" />
        <path d="M10.1 6.1A2.6 2.6 0 1 0 10.1 9.9" fill="none" stroke="#548af7" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  const tag = TAGS[ext];
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cls}>
      <path
        d="M3.5 1.5h6l3 3v10h-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        className="text-fg-subtle"
      />
      <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" className="text-fg-subtle" />
      {tag && (
        <>
          <rect x={tag.text.length > 2 ? 0.5 : 2} y="8.5" width={tag.text.length > 2 ? 15 : 12} height="6.5" rx="1.2" fill={tag.color} />
          <text
            x="8"
            y="13.4"
            textAnchor="middle"
            fontSize={tag.text.length > 2 ? 5 : 5.4}
            fontWeight="700"
            fill="#fff"
            fontFamily="Inter, 'Segoe UI', sans-serif"
          >
            {tag.text}
          </text>
        </>
      )}
    </svg>
  );
}

export function FolderIcon({ open, className }: { open: boolean; className?: string }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon strokeWidth={1.5} className={cn("size-4 shrink-0 text-fg-subtle", className)} />;
}

/** Colour-coded square with initials, used for project identity (like IDE project widgets). */
const PROJECT_COLORS = ["#4f7ed6", "#c75450", "#4c9a6a", "#b0782f", "#8d63c7", "#3f9aa8", "#c0588d", "#6f7f33"];

export function ProjectBadge({ name, className }: { name: string; className?: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const color = PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold text-white", className)}
      style={{ background: color }}
    >
      {initials}
    </span>
  );
}
