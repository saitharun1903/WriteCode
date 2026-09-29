import type { Metadata } from "next";
import { WorkspaceShell } from "@/features/workspace/WorkspaceShell";

// Session links are private: keep this page out of search results.
export const metadata: Metadata = {
  title: "Join a live coding session",
  robots: { index: false, follow: false },
};

/** Opened from a live session link: `/live#<session id>`. */
export default function LivePage() {
  return <WorkspaceShell live />;
}
