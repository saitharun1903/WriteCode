import { isSafeRelativePath, utf8ByteLength } from "../execution/validate.js";
import { getLanguage } from "../languages/registry.js";
import type { Project, ProjectFile, TestCase } from "./types.js";

/**
 * Sharing code by link, and moving projects to another browser.
 *
 * - A share is a read-only copy of a project's files at the moment it was
 *   shared: `/share#<id>` shows it, and anyone with the link can open a copy.
 * - A transfer is every chosen project, kept for a few minutes: the other
 *   browser opens `/get#<id>` (from a QR code) and the projects are added there.
 *
 * Both ids are random and long, travel after the `#` (so they are never sent in
 * a request line or kept in a log), and are the only key to the content.
 */
export const SHARE_LIMITS = {
  maxFiles: 50,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxNameChars: 120,
  /** A share lives this long after it was last opened. */
  ttlSeconds: 90 * 24 * 60 * 60,
  /** A transfer is for now: scan, and it is done. */
  transferTtlSeconds: 15 * 60,
  /** Everything in one transfer, bytes of JSON (the server accepts 2 MB a request). */
  transferMaxBytes: 1_800_000,
  transferMaxProjects: 40,
  /** A transfer can be fetched a few times (a reload, a second device), then it is gone. */
  transferMaxReads: 5,
} as const;

/** 96 random bits. */
export const SHARE_ID = /^[A-Za-z0-9_-]{16}$/;
/** 144 random bits: a transfer carries everything, so its id is longer. */
export const TRANSFER_ID = /^[A-Za-z0-9_-]{24}$/;

export interface SharedCode {
  name: string;
  language: string;
  entryFile: string;
  files: ProjectFile[];
  /** When it was shared, ms. */
  createdAt: number;
}

function cleanFiles(raw: unknown): ProjectFile[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SHARE_LIMITS.maxFiles) return null;
  const seen = new Set<string>();
  const files: ProjectFile[] = [];
  let total = 0;
  for (const f of raw) {
    if (!f || typeof f !== "object") return null;
    const { path, content } = f as Record<string, unknown>;
    if (typeof path !== "string" || typeof content !== "string" || !isSafeRelativePath(path) || seen.has(path)) return null;
    const size = utf8ByteLength(content);
    total += size;
    if (size > SHARE_LIMITS.maxFileBytes || total > SHARE_LIMITS.maxTotalBytes) return null;
    seen.add(path);
    files.push({ path, content });
  }
  return files;
}

const cleanName = (raw: unknown, fallback: string) =>
  (typeof raw === "string"
    ? raw
        // eslint-disable-next-line no-control-regex -- control characters have no place in a name
        .replace(/[\u0000-\u001f\u007f<>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, SHARE_LIMITS.maxNameChars)
    : "") || fallback;

/** Checks code sent to be shared (or received from a link); null when it is not usable. */
export function cleanSharedCode(raw: unknown, now = Date.now()): SharedCode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const language = typeof r.language === "string" ? getLanguage(r.language) : undefined;
  const files = cleanFiles(r.files);
  if (!language || !files) return null;
  const entry = typeof r.entryFile === "string" && files.some((f) => f.path === r.entryFile) ? r.entryFile : files[0]!.path;
  const createdAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) && r.createdAt > 0 && r.createdAt <= now ? r.createdAt : now;
  return { name: cleanName(r.name, `${language.name} project`), language: language.id, entryFile: entry, files, createdAt };
}

const time = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback);

/**
 * Checks one project of a transfer. What moves is the work itself: files,
 * folders, input and tests. Breakpoints and interviews stay where they were made.
 */
export function cleanTransferProject(raw: unknown, now = Date.now()): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const code = cleanSharedCode(raw, now);
  if (!code || typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) return null;
  const folders = Array.isArray(r.folders) ? r.folders.filter((f): f is string => typeof f === "string" && isSafeRelativePath(f)).slice(0, 200) : [];
  const stdin = typeof r.stdin === "string" && utf8ByteLength(r.stdin) <= SHARE_LIMITS.maxFileBytes ? r.stdin : "";
  const tests: TestCase[] = (Array.isArray(r.tests) ? r.tests : []).slice(0, 12).flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const { id, input, expected } = t as Record<string, unknown>;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) && typeof input === "string" && typeof expected === "string" && input.length + expected.length <= 300_000 ? [{ id, input, expected }] : [];
  });
  const updatedAt = Math.min(now, time(r.updatedAt, now));
  const lastRunAt = typeof r.lastRunAt === "number" ? Math.min(now, time(r.lastRunAt, now)) : undefined;
  return {
    id: r.id,
    name: code.name,
    language: code.language,
    entryFile: code.entryFile,
    files: code.files,
    folders,
    stdin,
    ...(tests.length ? { tests } : {}),
    createdAt: Math.min(updatedAt, time(r.createdAt, updatedAt)),
    updatedAt,
    ...(lastRunAt ? { lastRunAt } : {}),
  };
}
