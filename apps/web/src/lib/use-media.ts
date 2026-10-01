"use client";

import { useSyncExternalStore } from "react";

/** Subscribes to a CSS media query. Returns `false` during SSR. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** Phones, and touch tablets up to iPad Pro landscape: touch-sized controls, a tab bar (phones) or a rail of tabs (tablets). */
export const COMPACT_QUERY = "(max-width: 900px), (pointer: coarse) and (max-width: 1366px)";
