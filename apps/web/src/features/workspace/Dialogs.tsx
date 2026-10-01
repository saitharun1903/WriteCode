"use client";

import { CommandPalette } from "@/features/commands/CommandPalette";
import { EntryPointDialog } from "@/features/execution/EntryPointDialog";
import { ExportDialogs } from "@/features/export/ExportUI";
import { CompareDialog } from "@/features/history/CompareDialog";
import { CandidateGate } from "@/features/interview/CandidateGate";
import { FinishedPrompt } from "@/features/interview/FinishedPrompt";
import { InterviewSetupDialog } from "@/features/interview/InterviewSetupDialog";
import { ReplayDialog } from "@/features/interview/ReplayDialog";
import { JoinDialog, LivePanel, SessionEndedDialog } from "@/features/live/LiveUI";
import { ImportDialog } from "@/features/projects/ImportDialog";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";
import { SettingsDialog } from "@/features/settings/SettingsDialog";

/**
 * Every window that opens over the page. None is open when the page arrives,
 * so they are downloaded after it: on the visitor's first move, or with a project.
 */
export function Dialogs() {
  return (
    <>
      <CommandPalette />
      <NewProjectDialog />
      <SettingsDialog />
      <ImportDialog />
      <CompareDialog />
      <EntryPointDialog />
      <LivePanel />
      <JoinDialog />
      <InterviewSetupDialog />
      <ReplayDialog />
      <CandidateGate />
      <FinishedPrompt />
      <ExportDialogs />
      <SessionEndedDialog />
    </>
  );
}
