"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { DEFAULT_SETTINGS, useSettings, type ThemePreference } from "./store";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div>
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md bg-surface-3 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("h-6 rounded-[5px] px-2.5 text-xs", value === o.value ? "bg-surface-2 text-fg shadow-sm" : "text-fg-subtle hover:text-fg-muted")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative h-4.5 w-8 rounded-full transition-colors", checked ? "bg-accent" : "bg-line-strong")}
    >
      <span className={cn("absolute top-0.5 size-3.5 rounded-full bg-white transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

export function SettingsDialog() {
  const open = useUI((s) => s.settingsOpen);
  const setOpen = useUI((s) => s.setSettingsOpen);
  const s = useSettings();

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Settings"
      description="Saved in this browser."
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              const { theme, fontSize, tabSize, wordWrap, minimap, recordHistory } = DEFAULT_SETTINGS;
              s.update({ theme, fontSize, tabSize, wordWrap, minimap, recordHistory });
            }}
          >
            Restore defaults
          </Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </>
      }
    >
      <div className="divide-y divide-line">
        <Row label="Theme">
          <Segmented<ThemePreference>
            label="Theme"
            value={s.theme}
            onChange={(theme) => s.update({ theme })}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
          />
        </Row>
        <Row label="Editor font size">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={10}
              max={24}
              step={0.5}
              value={s.fontSize}
              onChange={(e) => s.update({ fontSize: Number(e.target.value) })}
              aria-label="Editor font size"
              className="w-28 accent-[var(--accent)]"
            />
            <span className="w-10 text-right font-mono text-xs text-fg-muted">{s.fontSize}px</span>
          </div>
        </Row>
        <Row label="Indentation" hint="Spaces inserted per Tab.">
          <Segmented
            label="Indentation"
            value={s.tabSize}
            onChange={(tabSize) => s.update({ tabSize })}
            options={[
              { value: 2, label: "2" },
              { value: 4, label: "4" },
              { value: 8, label: "8" },
            ]}
          />
        </Row>
        <Row label="Word wrap">
          <Switch label="Word wrap" checked={s.wordWrap} onChange={(wordWrap) => s.update({ wordWrap })} />
        </Row>
        <Row label="Minimap">
          <Switch label="Minimap" checked={s.minimap} onChange={(minimap) => s.update({ minimap })} />
        </Row>
        <Row label="Record run history" hint="Store code, input and output of each run locally.">
          <Switch label="Record run history" checked={s.recordHistory} onChange={(recordHistory) => s.update({ recordHistory })} />
        </Row>
      </div>
    </Dialog>
  );
}
