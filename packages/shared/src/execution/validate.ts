import { getLanguage } from "../languages/registry.js";
import { REQUEST_BOUNDS, type ExecutionRequest } from "./types.js";

export type ValidationResult = { ok: true; value: ExecutionRequest } | { ok: false; error: string };

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Accepts only relative paths made of safe segments. Rejects absolute paths,
 * `..`, backslashes and hidden files so nothing can escape the sandbox workdir.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > REQUEST_BOUNDS.maxPathLength) return false;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && !s.startsWith(".") && SAFE_SEGMENT.test(s));
}

/** UTF-8 byte length without relying on platform globals, so this runs in browser and Node alike. */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const byteLength = utf8ByteLength;

/** Structural validation of an untrusted execution request. */
export function validateExecutionRequest(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Request body must be an object." };
  const body = input as Record<string, unknown>;

  if (typeof body.language !== "string" || !getLanguage(body.language)) {
    return { ok: false, error: `Unsupported language: ${String(body.language)}` };
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return { ok: false, error: "At least one file is required." };
  }
  if (body.files.length > REQUEST_BOUNDS.maxFiles) {
    return { ok: false, error: `Too many files (max ${REQUEST_BOUNDS.maxFiles}).` };
  }

  const files: ExecutionRequest["files"] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of body.files as unknown[]) {
    if (typeof f !== "object" || f === null) return { ok: false, error: "Invalid file entry." };
    const { path, content } = f as Record<string, unknown>;
    if (typeof path !== "string" || !isSafeRelativePath(path)) {
      return { ok: false, error: `Invalid file path: ${String(path)}` };
    }
    if (seen.has(path)) return { ok: false, error: `Duplicate file path: ${path}` };
    if (typeof content !== "string") return { ok: false, error: `File content must be a string: ${path}` };
    const size = byteLength(content);
    if (size > REQUEST_BOUNDS.maxFileBytes) return { ok: false, error: `File too large: ${path}` };
    total += size;
    seen.add(path);
    files.push({ path, content });
  }
  if (total > REQUEST_BOUNDS.maxTotalBytes) return { ok: false, error: "Project too large to execute." };

  if (typeof body.entry !== "string" || !seen.has(body.entry)) {
    return { ok: false, error: "Entry file must be one of the submitted files." };
  }

  let stdin: string | undefined;
  if (body.stdin !== undefined) {
    if (typeof body.stdin !== "string") return { ok: false, error: "stdin must be a string." };
    if (byteLength(body.stdin) > REQUEST_BOUNDS.maxStdinBytes) return { ok: false, error: "stdin too large." };
    stdin = body.stdin;
  }

  return { ok: true, value: { language: body.language, files, entry: body.entry, stdin } };
}
