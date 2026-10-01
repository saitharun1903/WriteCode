import type { Metadata } from "next";
import { SharedCodePage } from "@/features/export/SharePages";

// Shared links are private to whoever has them: keep this page out of search results.
export const metadata: Metadata = {
  title: "Shared code",
  description: "Code shared from WriteCode: read it, copy it, keep it as a PDF or open your own copy in the editor.",
  robots: { index: false, follow: false },
};

/** Opened from a share link: `/share#<id>`. */
export default function SharePage() {
  return <SharedCodePage />;
}
