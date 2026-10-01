"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, ExternalLink, FileDown, Link2, QrCode, Share2, Smartphone } from "lucide-react";
import { PRODUCT } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { runCommand } from "@/features/commands/registry";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { useExport, type Transfer } from "./api";
import { safeFileName, saveFile } from "./code-pdf";
import { DownloadDialog } from "./DownloadDialog";
import { qrSvg } from "./qr";

const SITE = "writecode.in";

let logoPromise: Promise<string | undefined> | null = null;
/** The logo as a data address, so it can sit inside a picture that is saved or drawn to a canvas. */
function logoData(): Promise<string | undefined> {
  logoPromise ??= fetch("/logo.png")
    .then((r) => r.blob())
    .then(
      (blob) =>
        new Promise<string | undefined>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
          reader.onerror = () => resolve(undefined);
          reader.readAsDataURL(blob);
        }),
    )
    .catch(() => undefined);
  return logoPromise;
}

function useLogo(): string | undefined {
  const [logo, setLogo] = useState<string>();
  useEffect(() => {
    let live = true;
    void logoData().then((d) => live && setLogo(d));
    return () => {
      live = false;
    };
  }, []);
  return logo;
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** The code card as a PNG: the framed code, its caption and the product's name under it. */
async function cardPng(text: string, title: string, caption: string): Promise<Blob | null> {
  const logo = await logoData();
  const W = 900;
  const H = 1120;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const round = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  };
  // The frame: the brand's gradient, with a white card inside it.
  const frame = ctx.createLinearGradient(0, 0, W, H);
  frame.addColorStop(0, "#6d8cff");
  frame.addColorStop(0.5, "#8a7cf5");
  frame.addColorStop(1, "#c26cea");
  ctx.fillStyle = frame;
  round(0, 0, W, H, 64);
  ctx.fill();
  ctx.fillStyle = "#fff";
  round(14, 14, W - 28, H - 28, 52);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.fillStyle = "#1f2328";
  ctx.font = "700 44px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(title, W / 2, 104);
  ctx.fillStyle = "#6b727c";
  ctx.font = "400 27px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(caption, W / 2, 152);

  const art = qrSvg(text, logo);
  const url = URL.createObjectURL(new Blob([art.svg], { type: "image/svg+xml" }));
  try {
    const qr = await loadImage(url);
    ctx.drawImage(qr, 110, 190, 680, 680);
  } finally {
    URL.revokeObjectURL(url);
  }

  // The watermark: logo, name and address.
  ctx.font = "700 40px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const name = PRODUCT.name;
  const nameWidth = ctx.measureText(name).width;
  const mark = 52;
  const total = (logo ? mark + 16 : 0) + nameWidth;
  let x = (W - total) / 2;
  const y = 960;
  if (logo) {
    const img = await loadImage(logo).catch(() => null);
    if (img) ctx.drawImage(img, x, y - 40, mark, mark);
    x += mark + 16;
  }
  const brand = ctx.createLinearGradient(x, 0, x + nameWidth, 0);
  brand.addColorStop(0, "#3f63f2");
  brand.addColorStop(1, "#a63fd4");
  ctx.textAlign = "left";
  ctx.fillStyle = "#1f2328";
  const split = /^(.*[a-z])([A-Z][a-z]+)$/.exec(name);
  if (split) {
    ctx.fillText(split[1]!, x, y);
    ctx.fillStyle = brand;
    ctx.fillText(split[2]!, x + ctx.measureText(split[1]!).width, y);
  } else ctx.fillText(name, x, y);
  ctx.textAlign = "center";
  ctx.fillStyle = "#6b727c";
  ctx.font = "400 26px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(SITE, W / 2, 1012);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * A QR code people want to scan: the code in the brand's colours with the
 * logo in the middle, inside a glowing frame, with the product's name under it.
 */
export function QrCard({ text, title, caption, fileName, className }: { text: string; title: string; caption: string; fileName: string; className?: string }) {
  const logo = useLogo();
  const art = useMemo(() => qrSvg(text, logo), [text, logo]);
  const [saving, setSaving] = useState(false);
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="cw-qr-frame w-full max-w-[280px]">
        <div className="rounded-[22px] bg-white p-4 pb-3 text-center">
          <p className="text-[15px] font-semibold text-[#1f2328]">{title}</p>
          <p className="text-xs text-[#6b727c]">{caption}</p>
          <div data-qr={text} className="mx-auto mt-2 aspect-square w-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: art.svg }} />
          <p className="mt-1 flex items-center justify-center gap-1.5 text-[13px] font-bold text-[#1f2328]">
            {/* eslint-disable-next-line @next/next/no-img-element -- a small local icon */}
            <img src="/logo.png" alt="" width={18} height={18} className="size-[18px]" />
            <span>
              Write<span className="bg-gradient-to-r from-[#3f63f2] to-[#a63fd4] bg-clip-text text-transparent">Code</span>
            </span>
            <span className="font-normal text-[#6b727c]">· {SITE}</span>
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={saving}
        icon={saving ? <Spinner className="size-3" /> : <Download className="size-3.5" />}
        onClick={async () => {
          setSaving(true);
          const png = await cardPng(text, title, caption).catch(() => null);
          setSaving(false);
          if (png) saveFile(png, "image/png", `${safeFileName(fileName)}.png`);
          else toast.error("The image could not be made", "Take a screenshot of the code instead.");
        }}
      >
        Save as image
      </Button>
    </div>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-strong/70 bg-surface-2 p-1 pl-3">
      <span title={value} className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">
        {value}
      </span>
      <Button
        variant="primary"
        aria-label={label}
        icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            toast.error("Could not copy", "Select the link and copy it by hand.");
          }
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

/** Share the open project's code as a link anyone can open. */
function ShareDialog() {
  const project = useWorkspace((s) => s.project);
  // The link is for the code as it was when the dialog opened.
  const job = useExport((s) => s.share);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!job) return;
    let live = true;
    job.then(
      (l) => live && setLink(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [job]);
  if (!project) return null;
  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm">{error}</p>
      ) : !link ? (
        <p className="flex items-center gap-2 py-6 text-sm text-fg-subtle">
          <Spinner /> Making the link…
        </p>
      ) : (
        <>
          <CopyField value={link} label="Copy link" />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <a href={link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent hover:underline">
              <ExternalLink className="size-3.5" /> Open the shared page
            </a>
            {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
              <button type="button" className="flex items-center gap-1 text-accent hover:underline" onClick={() => void navigator.share({ title: `${project.name} on ${PRODUCT.name}`, url: link }).catch(() => {})}>
                <Share2 className="size-3.5" /> Send with an app
              </button>
            )}
          </div>
          <QrCard text={link} title={project.name.slice(0, 26)} caption="Scan to open this code" fileName={`${project.name}-link`} />
          <p className="text-xs leading-relaxed text-fg-subtle">
            Anyone with the link can read the code and open their own copy; they cannot change yours. It is the code as it is now: later edits are not included. The link works for 90 days after it was last opened.
          </p>
        </>
      )}
    </div>
  );
}

function useCountdown(until: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : null;
}

/** Move this browser's projects to another one: a code to scan there. */
function TransferDialog() {
  const job = useExport((s) => s.transfer);
  const [state, setState] = useState<Transfer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = useCountdown(state?.expiresAt ?? null);

  useEffect(() => {
    if (!job) return;
    let live = true;
    job.then(
      (made) => live && setState(made),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [job]);

  if (error) return <p className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm">{error}</p>;
  if (!state) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-fg-subtle">
        <Spinner /> Getting your projects ready…
      </p>
    );
  }
  const n = state.sent.length;
  return (
    <div className="space-y-4">
      <ol className="space-y-1 text-[13px] text-fg-muted">
        <li>
          <b className="text-fg">1.</b> On the other phone or computer, open the camera and point it at this code.
        </li>
        <li>
          <b className="text-fg">2.</b> Open the link it shows. Your {n === 1 ? "project is" : `${n} projects are`} added there at once.
        </li>
      </ol>
      {left ? (
        <QrCard text={state.link} title={`${n} project${n === 1 ? "" : "s"}`} caption="Scan to bring them to this device" fileName="writecode-projects" />
      ) : (
        <div className="rounded-lg border border-warning/50 bg-warning-soft p-4 text-center text-sm">
          <p>This code has expired.</p>
          <Button
            className="mt-2"
            variant="primary"
            onClick={() => {
              setState(null);
              useExport.getState().renewTransfer();
            }}
          >
            Make a new code
          </Button>
        </div>
      )}
      {left && (
        <>
          <p className="text-center text-xs text-fg-subtle">
            Works for <span className="font-mono text-fg">{left}</span> more. No camera there? Copy the link and open it on the other device.
          </p>
          <CopyField value={state.link} label="Copy link" />
        </>
      )}
      <details className="text-xs text-fg-subtle">
        <summary className="cursor-pointer select-none hover:text-fg">
          What moves ({n} project{n === 1 ? "" : "s"})
        </summary>
        <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto pl-4">
          {state.sent.map((p) => (
            <li key={p.id} className="truncate">
              {p.name}
            </li>
          ))}
        </ul>
        {state.left.length > 0 && <p className="mt-1.5 text-warning">Too large for one code, not included: {state.left.map((p) => p.name).join(", ")}. Move them afterwards, or share them by link.</p>}
        <p className="mt-1.5">Files, folders, input and tests move. Your projects also stay here. Anyone who gets this code within 15 minutes can copy them, so show it only to yourself.</p>
      </details>
    </div>
  );
}

/** The export dialogs, mounted once in the shell. */
export function ExportDialogs() {
  const dialog = useExport((s) => s.dialog);
  const close = useExport((s) => s.close);
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  return (
    <>
      <DownloadDialog source={dialog === "download" && project ? { name: project.name, language: project.language, entryFile: project.entryFile, files: project.files, activeFile } : null} onClose={close} />
      <Dialog open={dialog === "share"} onOpenChange={(o) => !o && close()} title="Share this code" description="A link to a read-only copy of the project, as it is now." className="top-[6vh] max-h-[90vh] max-w-md overflow-y-auto">
        {dialog === "share" && <ShareDialog />}
      </Dialog>
      <Dialog open={dialog === "transfer"} onOpenChange={(o) => !o && close()} title="Move projects to another device" description="Scan a code and your projects appear in the other browser." className="top-[6vh] max-h-[90vh] max-w-md overflow-y-auto">
        {dialog === "transfer" && <TransferDialog />}
      </Dialog>
    </>
  );
}

/** Title bar: download the code as one file, share it by link, or move projects to another device. */
export function ExportButton() {
  return (
    <DropdownMenu
      align="end"
      entries={[
        { label: "Download code…", icon: <FileDown />, onSelect: () => runCommand("file.downloadPdf") },
        { label: "Share a link to this code…", icon: <Link2 />, onSelect: () => runCommand("file.shareLink") },
        { kind: "separator" },
        { label: "Move projects to another device…", icon: <Smartphone />, onSelect: () => runCommand("project.transfer") },
      ]}
      trigger={
        <IconButton label="Download and share">
          <Download />
        </IconButton>
      }
    />
  );
}

/** Start screen: the way to bring projects to another browser. */
export function TransferButton({ className }: { className?: string }) {
  return (
    <Button variant="ghost" className={className} icon={<QrCode className="size-4" />} onClick={() => useExport.getState().open("transfer")}>
      Move to another device
    </Button>
  );
}
