"use client";

import { COMPACT_QUERY, useMediaQuery } from "@/lib/use-media";
import { CODE_FONTS, applyCodeFont } from "./fonts";
import { useMemo, useState, type ReactNode } from "react";
import { Code2, Keyboard, Minus, Palette, Play, Plus, Search, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { COMMANDS } from "@/features/commands/registry";
import { useExecution } from "@/features/execution/store";
import { historyRepo } from "@/features/projects/db";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { DEFAULT_SETTINGS, PREFERENCE_KEYS, useSettings, type Settings, type ThemePreference } from "./store";

type Section = "appearance" | "editor" | "help" | "running" | "shortcuts";

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "editor", label: "Editor", icon: <Code2 /> },
  { id: "help", label: "Coding help", icon: <Wand2 /> },
  { id: "running", label: "Running", icon: <Play /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Keyboard /> },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      {title && <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{title}</h3>}
      <div className="divide-y divide-line-strong/40">{children}</div>
    </section>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-surface-3 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("h-7 min-w-9 rounded-md px-2.5 text-xs transition-colors", value === o.value ? "bg-overlay text-fg shadow-sm" : "text-fg-subtle hover:text-fg")}
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
      className={cn("relative h-5 w-9 rounded-full transition-colors duration-200", checked ? "bg-accent" : "bg-line-strong")}
    >
      <span className={cn("absolute left-0 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-200", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

/** A small picture of the IDE in each theme. */
function ThemeCard({ value, label, current, onPick }: { value: ThemePreference; label: string; current: ThemePreference; onPick: (v: ThemePreference) => void }) {
  const pane = (dark: boolean) => (
    <div className={cn("flex h-full flex-1 flex-col gap-1 p-2", dark ? "bg-[#0b0d13]" : "bg-[#f7f8fa]")}>
      <div className={cn("h-1.5 w-8 rounded-full", dark ? "bg-[#c296ff]" : "bg-[#0033b3]")} />
      <div className={cn("h-1.5 w-12 rounded-full", dark ? "bg-[#8fd694]" : "bg-[#067d17]")} />
      <div className={cn("h-1.5 w-6 rounded-full", dark ? "bg-[#7cc4ff]" : "bg-[#00627a]")} />
      <div className={cn("mt-auto h-3 rounded-sm", dark ? "bg-[#212636]" : "bg-[#ebecf0]")} />
    </div>
  );
  const active = current === value;
  return (
    <button
      role="radio"
      aria-checked={active}
      aria-label={label}
      onClick={() => onPick(value)}
      className="group flex flex-1 flex-col items-center gap-2 text-xs"
    >
      <span className={cn("flex h-20 w-full overflow-hidden rounded-lg border-2 transition-colors", active ? "border-accent" : "border-line-strong group-hover:border-fg-faint")}>
        {value === "system" ? (
          <>
            {pane(false)}
            {pane(true)}
          </>
        ) : (
          pane(value === "dark")
        )}
      </span>
      <span className={active ? "font-medium text-fg" : "text-fg-subtle"}>{label}</span>
    </button>
  );
}

const PREVIEW = `for (int i = 0; i < n; i++) {
    total += scores[i];
}`;

function Appearance({ s }: { s: Settings & { update: (p: Partial<Settings>) => void } }) {
  return (
    <>
      <Group title="Theme">
        <div role="radiogroup" aria-label="Theme" className="flex gap-3 py-3">
          <ThemeCard value="dark" label="Dark" current={s.theme} onPick={(theme) => s.update({ theme })} />
          <ThemeCard value="light" label="Light" current={s.theme} onPick={(theme) => s.update({ theme })} />
          <ThemeCard value="system" label="System" current={s.theme} onPick={(theme) => s.update({ theme })} />
        </div>
      </Group>
      <Group title="Text">
        <Row label="Editor font size">
          <div className="flex items-center gap-1 rounded-lg bg-surface-3 p-0.5">
            <button aria-label="Smaller" disabled={s.fontSize <= 10} onClick={() => s.update({ fontSize: s.fontSize - 1 })} className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-overlay disabled:opacity-40">
              <Minus className="size-3.5" />
            </button>
            <span aria-live="polite" className="w-10 text-center font-mono text-xs text-fg">
              {s.fontSize}px
            </span>
            <button aria-label="Larger" disabled={s.fontSize >= 24} onClick={() => s.update({ fontSize: s.fontSize + 1 })} className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-overlay disabled:opacity-40">
              <Plus className="size-3.5" />
            </button>
          </div>
        </Row>
        <Row label="Code font" hint="Used in the editor, the console and everywhere else code is shown.">
          <select
            aria-label="Code font"
            value={s.codeFont}
            onChange={(e) => {
              applyCodeFont(e.target.value);
              s.update({ codeFont: e.target.value });
            }}
            className="h-9 min-w-44 cursor-pointer rounded-lg border border-line-strong bg-surface-3 px-2.5 text-sm text-fg outline-none focus-visible:border-accent"
          >
            {CODE_FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>
        <pre aria-hidden className="cw-console mb-1 overflow-hidden rounded-lg bg-surface-3/60 px-3 py-2 font-mono text-fg" style={{ fontSize: s.fontSize, lineHeight: `${Math.round(s.fontSize * 1.45)}px` }}>
          {PREVIEW}
        </pre>
      </Group>
    </>
  );
}

function Running() {
  const recordHistory = useSettings((s) => s.recordHistory);
  const update = useSettings((s) => s.update);
  const [cleared, setCleared] = useState(false);
  return (
    <Group>
      <Row label="Keep run history" hint="Saves the code, input and output of every run in this browser, so you can compare or restore them.">
        <Switch label="Keep run history" checked={recordHistory} onChange={(v) => update({ recordHistory: v })} />
      </Row>
      <Row label="Clear run history" hint="Removes every saved run. Projects are not affected.">
        <Button
          size="sm"
          disabled={cleared}
          onClick={async () => {
            await historyRepo.clear();
            useExecution.getState().bumpHistory();
            setCleared(true);
          }}
        >
          {cleared ? "Cleared" : "Clear"}
        </Button>
      </Row>
    </Group>
  );
}

function Shortcuts() {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return COMMANDS.filter((c) => c.shortcut && (!q || c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)));
  }, [query]);
  return (
    <div className="flex h-full flex-col">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          className="h-8 w-full rounded-lg border border-line-strong bg-surface-2 pl-8 pr-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent"
        />
      </div>
      <ul aria-label="Keyboard shortcuts" className="min-h-0 flex-1 divide-y divide-line-strong/40 overflow-y-auto">
        {rows.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-4 py-2 text-sm">
            <span className="min-w-0 truncate text-fg">
              {c.title}
              <span className="ml-2 text-xs text-fg-subtle">{c.category}</span>
            </span>
            <Kbd shortcut={c.shortcut!.split(" / ")[0]!} />
          </li>
        ))}
        {rows.length === 0 && <li className="py-6 text-center text-sm text-fg-subtle">No shortcut matches “{query}”.</li>}
      </ul>
    </div>
  );
}

export function SettingsDialog() {
  const open = useUI((s) => s.settingsOpen);
  const setOpen = useUI((s) => s.setSettingsOpen);
  const s = useSettings();
  const [section, setSection] = useState<Section>("appearance");
  // Phones and touch tablets: the dialog fills the screen (phones) or most of it, and has no keyboard shortcuts to list.
  const compact = useMediaQuery(COMPACT_QUERY);
  const phone = useMediaQuery("(max-width: 639px)");
  const sections = compact ? SECTIONS.filter((sec) => sec.id !== "shortcuts") : SECTIONS;

  const restore = () => s.update(Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<Settings>);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Settings"
      className={cn("top-[10vh] max-w-3xl", compact && "top-[5vh]", phone && "left-0 top-0 flex h-dvh w-screen max-w-none translate-x-0 flex-col rounded-none [&>div:nth-child(2)]:min-h-0 [&>div:nth-child(2)]:flex-1")}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={restore}>
            Restore defaults
          </Button>
          <Button variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        </>
      }
    >
      <div className={cn("flex h-[min(480px,64vh)] flex-col gap-4 sm:flex-row", compact && "h-[min(680px,74vh)]", phone && "h-full gap-3")}>
        <nav aria-label="Settings sections" className={cn("flex shrink-0 gap-1 overflow-x-auto sm:w-44 sm:flex-col sm:overflow-visible", phone && "flex-wrap gap-1.5 overflow-visible")}>
          {sections.map((sec) => (
            <button
              key={sec.id}
              aria-current={section === sec.id ? "page" : undefined}
              onClick={() => setSection(sec.id)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors [&_svg]:size-4",
                compact && "h-10 px-3 text-[15px]",
                phone && "border border-line-strong/60",
                section === sec.id ? "bg-accent-soft/70 text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
              )}
            >
              <span className={section === sec.id ? "text-accent-ink" : "text-fg-subtle"}>{sec.icon}</span>
              {sec.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto sm:border-l sm:border-line-strong/50 sm:pl-5">
          {section === "appearance" && <Appearance s={s} />}
          {section === "editor" && (
            <Group>
              <Row label="Indentation" hint="Spaces inserted for each Tab.">
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
              <Row label="Word wrap" hint="Wrap long lines to the width of the editor.">
                <Switch label="Word wrap" checked={s.wordWrap} onChange={(wordWrap) => s.update({ wordWrap })} />
              </Row>
              <Row label="Minimap" hint="A zoomed-out outline of the file beside the scrollbar.">
                <Switch label="Minimap" checked={s.minimap} onChange={(minimap) => s.update({ minimap })} />
              </Row>
              <Row label="Colour bracket pairs" hint="Matching brackets get the same colour, with a guide line.">
                <Switch label="Colour bracket pairs" checked={s.bracketColors} onChange={(bracketColors) => s.update({ bracketColors })} />
              </Row>
            </Group>
          )}
          {section === "help" && (
            <Group>
              <Row label="Add imports automatically" hint="Using Scanner, ArrayList, math. or deque adds the import at the top. Ctrl+Z takes it back.">
                <Switch label="Add imports automatically" checked={s.autoImport} onChange={(autoImport) => s.update({ autoImport })} />
              </Row>
              <Row label="Close brackets and quotes" hint="Typing ( [ { or a quote adds the closing one.">
                <Switch label="Close brackets and quotes" checked={s.autoClose} onChange={(autoClose) => s.update({ autoClose })} />
              </Row>
              <Row label="Suggestions while typing" hint="Show completions and snippets such as sout and fori as you type. Ctrl+Space always shows them.">
                <Switch label="Suggestions while typing" checked={s.suggestions} onChange={(suggestions) => s.update({ suggestions })} />
              </Row>
            </Group>
          )}
          {section === "running" && <Running />}
          {section === "shortcuts" && <Shortcuts />}
        </div>
      </div>
    </Dialog>
  );
}
