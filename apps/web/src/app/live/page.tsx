import { WorkspaceShell } from "@/features/workspace/WorkspaceShell";

/** Opened from a live session link: `/live#<session id>`. */
export default function LivePage() {
  return <WorkspaceShell live />;
}
