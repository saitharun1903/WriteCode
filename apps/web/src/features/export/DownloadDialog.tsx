"use client";

import { useMemo, useState } from "react";
import { Download, FileText, FileType, FileType2 } from "lucide-react";
import type { ProjectFile } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { CODE_FORMATS, type CodeFormat } from "./code-doc";
import { FilePicker, inOrder, linesOf } from "./FilePicker";

/** The code a download is made from. */
export interface DownloadSource {
  name: string;
  language: string;
  entryFile: string;
  files: ProjectFile[];
  /** When the copy was made, ms (a shared link's code); now when not given. */
  at?: number;
  /** The file on screen, offered as "only this file". */
  activeFile?: string | null;
}

const ICON: Record<CodeFormat, typeof FileText> = { pdf: FileType, word: FileType2, text: FileText };

function Chooser({ source, onDone }: { source: DownloadSource; onDone: () => void }) {
  // The entry file first, then the rest by name: the order they appear in the download.
  const files = useMemo(() => inOrder(source.files, source.entryFile), [source.files, source.entryFile]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(files.map((f) => f.path)));
  const [format, setFormat] = useState<CodeFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const picked = files.filter((f) => chosen.has(f.path));
  const lines = picked.reduce((n, f) => n + linesOf(f.content), 0);
  const chosenFormat = CODE_FORMATS.find((f) => f.id === format)!;

  const download = async () => {
    setBusy(true);
    try {
      const { downloadCode } = await import("./code-doc");
      await downloadCode({ name: source.name, language: source.language, entryFile: source.entryFile, files: picked, at: source.at }, format);
      onDone();
    } catch {
      toast.error("The file could not be made", "Try again, or choose another format.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <FilePicker id="download-files" files={files} activeFile={source.activeFile} chosen={chosen} onChange={setChosen} />

      <section aria-labelledby="download-format">
        <h3 id="download-format" className="text-sm font-semibold text-fg">
          Format
        </h3>
        <div role="radiogroup" aria-labelledby="download-format" className="mt-2 grid grid-cols-3 gap-2">
          {CODE_FORMATS.map((f) => {
            const Icon = ICON[f.id];
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={format === f.id}
                onClick={() => setFormat(f.id)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-sm font-medium transition-colors",
                  format === f.id ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-muted hover:bg-hover",
                )}
              >
                <Icon className="size-5" />
                {f.label}
                <span className="text-[11px] font-normal text-fg-subtle">.{f.extension}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-fg-subtle">{chosenFormat.detail}</p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-strong/60 pt-3">
        <p aria-live="polite" className="text-xs text-fg-muted">
          {picked.length === 0 ? "Choose at least one file." : `${picked.length} file${picked.length === 1 ? "" : "s"}, ${lines} line${lines === 1 ? "" : "s"}, in one ${chosenFormat.label} file.`}
        </p>
        <Button variant="primary" disabled={busy || picked.length === 0} icon={busy ? <Spinner className="size-3.5" /> : <Download className="size-4" />} onClick={() => void download()}>
          Download
        </Button>
      </div>
    </div>
  );
}

/**
 * Asks what to download before making the file: every file of the code or
 * only the chosen ones, and the format. The answer is always one file.
 */
export function DownloadDialog({ source, onClose }: { source: DownloadSource | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!source}
      onOpenChange={(o) => !o && onClose()}
      title="Download code"
      description="Choose the files and the format. They are put together into one file."
      className="top-[8vh] max-h-[88vh] max-w-md overflow-y-auto"
    >
      {source && <Chooser key={`${source.name}:${source.files.length}`} source={source} onDone={onClose} />}
    </Dialog>
  );
}
