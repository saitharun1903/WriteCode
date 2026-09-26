"use client";

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { create } from "zustand";
import { cn } from "@/lib/cn";

type Tone = "info" | "success" | "error";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.tone === "error" ? 7000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (title: string, description?: string) => useToasts.getState().push({ tone: "info", title, description }),
  success: (title: string, description?: string) => useToasts.getState().push({ tone: "success", title, description }),
  error: (title: string, description?: string) => useToasts.getState().push({ tone: "error", title, description }),
};

const icons = { info: Info, success: CheckCircle2, error: AlertCircle };
const toneClass = { info: "text-info", success: "text-success", error: "text-danger" };

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-8 right-3 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = icons[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex gap-2.5 rounded-md border border-line bg-overlay p-3 shadow-float animate-slide-up"
          >
            <Icon className={cn("mt-px size-4 shrink-0", toneClass[t.tone])} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">{t.title}</p>
              {t.description && <p className="mt-0.5 break-words text-xs text-fg-muted">{t.description}</p>}
            </div>
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="h-fit rounded-sm p-0.5 text-fg-subtle hover:text-fg">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
