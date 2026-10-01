"use client";

import { useState } from "react";
import { CheckCircle2, FileDown, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { VERDICT_TEXT, verdictDetail } from "./CandidateTests";
import { useReport } from "./InterviewPanel";
import { useInterviewUI } from "./ui";

function Body({ onClose }: { onClose: () => void }) {
  const iv = useLive((s) => s.interview)!;
  const project = useWorkspace((s) => s.project);
  const report = useReport();
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const v = iv.verdicts?.at(-1);

  return (
    <div className="space-y-3 text-[13.5px] leading-relaxed">
      <p className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        <span>
          {iv.endReason ? `${iv.endReason}. ` : ""}Sharing has stopped: the session is closed for {iv.candidate ?? "the candidate"} and for you, and the cameras are off.
        </span>
      </p>
      {v && v.status !== "error" && (
        <p className="rounded-lg border border-line-strong/60 p-3">
          <b className={v.status === "accepted" ? "text-success" : "text-danger"}>{VERDICT_TEXT[v.status]}</b>
          <span className="block text-xs text-fg-muted">{verdictDetail(v)}</span>
        </p>
      )}
      {discarding ? (
        <div className="rounded-lg border border-danger/40 bg-danger-soft p-3">
          <p className="font-medium">Delete this interview for good?</p>
          <p className="mt-0.5 text-xs text-fg-muted">The candidate&rsquo;s code, the activity, your notes, the report and the recording are removed from this browser. This cannot be undone.</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setDiscarding(false)}>
              Go back
            </Button>
            <Button
              variant="danger"
              disabled={busy || !project}
              icon={<Trash2 className="size-4" />}
              onClick={async () => {
                if (!project) return;
                setBusy(true);
                await useWorkspace.getState().deleteProject(project.id);
                setBusy(false);
                onClose();
                toast.info("The interview was not saved");
              }}
            >
              Delete it
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-line-strong/60 bg-surface-2 p-3">
            <p className="font-medium">Save this interview?</p>
            <p className="mt-0.5 text-xs text-fg-muted">Saved, it stays under Interviews on the start screen, with its report, notes and recording. Not saved, it is deleted from this browser.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button className="mr-auto" variant="ghost" disabled={!report.ready} icon={<FileDown className="size-4" />} onClick={() => void report.pdf()}>
              Report (PDF)
            </Button>
            <Button onClick={() => setDiscarding(true)}>Don&rsquo;t save</Button>
            <Button
              variant="primary"
              icon={<Save className="size-4" />}
              onClick={() => {
                onClose();
                toast.success("Interview saved", "It is under Interviews on the start screen.");
              }}
            >
              Save interview
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The interviewer's side, when an interview has just finished and its session
 * has closed: how it went, and whether to keep it. Closing the dialog keeps it.
 */
export function FinishedPrompt() {
  const open = useInterviewUI((s) => s.savePrompt);
  const iv = useLive((s) => s.interview);
  const owner = useLive((s) => s.role === "owner");
  const close = () => useInterviewUI.getState().setSavePrompt(false);
  const shown = open && !!iv && owner;
  return (
    <Dialog open={shown} onOpenChange={(o) => !o && close()} title="The interview is finished" description={iv ? `${iv.title}${iv.candidate ? ` · ${iv.candidate}` : ""}` : undefined} className="max-w-md">
      {shown && <Body onClose={close} />}
    </Dialog>
  );
}
