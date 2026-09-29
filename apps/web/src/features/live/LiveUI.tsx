"use client";

import { useState } from "react";
import { Check, Copy, Eye, LogOut, Mail, Pencil, Radio, Share2, UserMinus, Users } from "lucide-react";
import { LIVE_COLORS, LIVE_ROLE_LABEL, PRODUCT, type LiveJoinRole, type LiveParticipant } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { liveLink, useLive } from "./store";

const colorOf = (p: Pick<LiveParticipant, "color">) => LIVE_COLORS[p.color % LIVE_COLORS.length]!;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

function Avatar({ person, size = 24, ring }: { person: LiveParticipant; size?: number; ring?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", ring && "ring-2 ring-canvas")}
      style={{ width: size, height: size, background: colorOf(person), fontSize: Math.round(size * 0.42) }}
    >
      {initials(person.name)}
    </span>
  );
}

const ACTIVE = new Set(["connecting", "connected", "reconnecting", "waiting"]);

/** Title bar: "Share" to start a session, or the people in it. */
export function LiveButton() {
  const status = useLive((s) => s.status);
  const participants = useLive((s) => s.participants);
  const setPanelOpen = useLive((s) => s.setPanelOpen);
  const project = useWorkspace((s) => s.project);
  if (!project) return null;
  const active = ACTIVE.has(status);
  if (!active) {
    return (
      <Tooltip content="Code together live: share a link">
        <button
          type="button"
          aria-label="Share live session"
          onClick={() => setPanelOpen(true)}
          className="flex h-[30px] items-center gap-1.5 rounded-full border border-line-strong/80 px-3 text-[13px] font-medium text-fg-muted transition-colors hover:border-accent/60 hover:text-fg"
        >
          <Users className="size-3.5" />
          <span className="hidden md:inline">Share</span>
        </button>
      </Tooltip>
    );
  }
  const shown = participants.slice(0, 4);
  return (
    <button
      type="button"
      aria-label={`Live session: ${participants.length} ${participants.length === 1 ? "person" : "people"}`}
      onClick={() => setPanelOpen(true)}
      className="flex h-[30px] items-center gap-2 rounded-full border border-success/40 bg-success/10 pl-1.5 pr-2.5 text-[13px] font-medium text-fg transition-colors hover:bg-success/15"
    >
      <span className="flex -space-x-1.5">
        {shown.map((p) => (
          <Avatar key={p.id} person={p} size={20} ring />
        ))}
      </span>
      {participants.length > shown.length && <span className="text-xs text-fg-muted">+{participants.length - shown.length}</span>}
      <span className="flex items-center gap-1 text-success">
        <span className={cn("size-1.5 rounded-full bg-current", status === "connected" ? "animate-pulse" : "opacity-50")} />
        Live
      </span>
    </button>
  );
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** The invitation text, for email and messaging apps. */
function inviteText(link: string, from: string, project: string, canEdit: boolean) {
  return {
    subject: `${from} invited you to code together on ${PRODUCT.name}`,
    body: [
      "Hi!",
      `${from} is sharing the project "${project}" live on ${PRODUCT.name}. Open this link to join. ` +
        `You will see the code, everyone's cursors and the program's output as they happen${canEdit ? ", and you can edit too" : ""}.`,
      link,
      "No sign-up needed: just type your name.",
    ].join("\n\n"),
  };
}

/** Invite people: opens your own email app with the invitation written, or WhatsApp, or the phone's share sheet. */
function Invite({ roomId }: { roomId: string }) {
  const [emails, setEmails] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const me = useLive((s) => s.me);
  const defaultRole = useLive((s) => s.defaultRole);
  const project = useWorkspace((s) => s.project?.name ?? "project");
  const text = inviteText(liveLink(roomId), me?.name ?? "Someone", project, defaultRole === "editor");
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const sendEmail = () => {
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    const bad = list.filter((e) => !EMAIL.test(e));
    if (!list.length) return setProblem("Type at least one email address.");
    if (bad.length) return setProblem(`Check ${bad.length === 1 ? "this address" : "these addresses"}: ${bad.join(", ")}`);
    setProblem(null);
    // Your own email app sends it, from your address: nothing goes through our server.
    window.location.href = `mailto:${list.map(encodeURIComponent).join(",")}?subject=${encodeURIComponent(text.subject)}&body=${encodeURIComponent(text.body)}`;
  };

  return (
    <div className="space-y-1.5">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          sendEmail();
        }}
      >
        <Input
          aria-label="Invite by email"
          value={emails}
          onChange={(e) => {
            setEmails(e.target.value);
            setProblem(null);
          }}
          placeholder="Invite by email: friend@gmail.com, …"
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="secondary" icon={<Mail className="size-3.5" />}>
          Email
        </Button>
      </form>
      {problem && <p className="text-xs text-danger">{problem}</p>}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
        <span>or send it with</span>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(text.body)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-line-strong/70 px-2 py-0.5 font-medium text-fg-muted hover:bg-hover hover:text-fg"
        >
          WhatsApp
        </a>
        {canShare && (
          <button
            type="button"
            onClick={() => void navigator.share({ title: text.subject, text: text.body }).catch(() => {})}
            className="flex items-center gap-1 rounded-md border border-line-strong/70 px-2 py-0.5 font-medium text-fg-muted hover:bg-hover hover:text-fg"
          >
            <Share2 className="size-3" /> More apps…
          </button>
        )}
      </div>
    </div>
  );
}

function CopyLink({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const link = liveLink(roomId);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-strong/70 bg-surface-2 p-1 pl-3">
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted" title={link}>
        {link}
      </span>
      <Button
        variant="primary"
        icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        onClick={() =>
          void navigator.clipboard?.writeText(link).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => toast.error("Could not copy", "Select the link and copy it yourself."),
          )
        }
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

function RoleChoice({ value, onChange, label }: { value: LiveJoinRole; onChange: (r: LiveJoinRole) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line-strong/70 p-0.5 text-xs">
      {(["editor", "viewer"] as const).map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          onClick={() => onChange(r)}
          className={cn("flex items-center gap-1 rounded-[5px] px-2 py-1 transition-colors", value === r ? "bg-active text-fg" : "text-fg-subtle hover:text-fg")}
        >
          {r === "editor" ? <Pencil className="size-3" /> : <Eye className="size-3" />}
          {LIVE_ROLE_LABEL[r]}
        </button>
      ))}
    </div>
  );
}

function People() {
  const participants = useLive((s) => s.participants);
  const me = useLive((s) => s.me);
  const presence = useLive((s) => s.presence);
  const following = useLive((s) => s.following);
  const owner = useLive((s) => s.role === "owner");
  const live = useLive.getState();
  return (
    <ul aria-label="People in this session" className="max-h-[40vh] space-y-0.5 overflow-y-auto">
      {participants.map((p) => {
        const you = p.id === me?.id;
        const where = presence[p.id]?.file;
        return (
          <li key={p.id} className="group flex items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-hover">
            <Avatar person={p} size={26} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-fg">
                {p.name}
                {you && <span className="text-fg-subtle"> (you)</span>}
              </div>
              <div className="truncate text-xs text-fg-subtle">
                {p.role === "owner" ? "Owner" : LIVE_ROLE_LABEL[p.role]}
                {where && !you ? ` · in ${where.split("/").pop()}` : ""}
              </div>
            </div>
            {!you && (
              <Button size="sm" variant={following === p.id ? "primary" : "ghost"} onClick={() => live.follow(following === p.id ? null : p.id)}>
                {following === p.id ? "Following" : "Follow"}
              </Button>
            )}
            {owner && !you && p.role !== "owner" && (
              <>
                <RoleChoice value={p.role as LiveJoinRole} onChange={(r) => live.setRole(p.id, r)} label={`What ${p.name} can do`} />
                <Tooltip content={`Remove ${p.name}`}>
                  <button
                    type="button"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => live.remove(p.id)}
                    className="rounded-md p-1 text-fg-subtle hover:bg-danger/15 hover:text-danger"
                  >
                    <UserMinus className="size-4" />
                  </button>
                </Tooltip>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Start a session, or manage the one in progress. */
export function LivePanel() {
  const open = useLive((s) => s.panelOpen);
  const status = useLive((s) => s.status);
  const roomId = useLive((s) => s.roomId);
  const role = useLive((s) => s.role);
  const defaultRole = useLive((s) => s.defaultRole);
  const error = useLive((s) => s.error);
  const savedName = useLive((s) => s.name);
  const shared = useWorkspace((s) => !!s.sharedId);
  const [name, setName] = useState(savedName);
  const live = useLive.getState();
  const active = ACTIVE.has(status) && !!roomId;
  const owner = role === "owner";

  return (
    <Dialog
      open={open}
      onOpenChange={live.setPanelOpen}
      title={active ? "Live session" : "Code together, live"}
      description={
        active
          ? owner
            ? "Everyone with the link sees your code, cursors and runs as they happen."
            : "You are in someone else's live session."
          : "Share a link. Others see your code, cursors, runs and debugging live, and can edit with you if you allow it."
      }
      className="max-w-lg"
    >
      {!active ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void live.start(name);
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-fg-muted">Your name, shown to others</span>
            <Input autoFocus value={name} maxLength={40} placeholder="e.g. Ravi" onChange={(e) => setName(e.target.value)} />
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon={status === "starting" ? <Spinner /> : <Radio className="size-3.5" />} disabled={status === "starting" || !name.trim()}>
              Start live session
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          {status === "reconnecting" && <p className="rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">Connection lost. Reconnecting… your changes are kept and sent when you are back.</p>}
          <CopyLink roomId={roomId!} />
          <Invite roomId={roomId!} />
          {owner && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-fg-muted">People who join with the link</span>
              <RoleChoice value={defaultRole} onChange={live.setDefaultRole} label="What people who join can do" />
            </div>
          )}
          <People />
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
            {owner ? (
              <>
                <Button variant="ghost" onClick={() => live.setPanelOpen(false)}>
                  Close
                </Button>
                <Button variant="danger" onClick={live.end}>
                  End session for everyone
                </Button>
              </>
            ) : (
              <>
                {shared && (
                  <Button variant="secondary" onClick={() => void live.saveCopy()}>
                    Save a copy
                  </Button>
                )}
                <Button variant="ghost" icon={<LogOut className="size-3.5" />} onClick={live.leave}>
                  Leave
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Asks for a name when a live link is opened. */
export function JoinDialog() {
  const roomId = useLive((s) => s.joinPrompt);
  const savedName = useLive((s) => s.name);
  const [name, setName] = useState(savedName);
  return (
    <Dialog
      open={!!roomId}
      onOpenChange={(open) => {
        if (open) return;
        useLive.setState({ joinPrompt: null });
        history.replaceState(null, "", "/");
      }}
      title="Join live session"
      description="You are joining someone's project. They will see your name and cursor."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (roomId && name.trim()) useLive.getState().join(roomId, name);
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-fg-muted">Your name</span>
          <Input autoFocus value={name} maxLength={40} placeholder="e.g. Priya" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Join
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A guest's session ended, they were removed, or the link did not work. */
export function SessionEndedDialog() {
  const status = useLive((s) => s.status);
  const owner = useLive((s) => s.owner);
  const error = useLive((s) => s.error);
  const shared = useWorkspace((s) => !!s.sharedId);
  const open = !owner && (status === "ended" || status === "removed" || status === "failed");
  const live = useLive.getState();
  const close = () => {
    live.dismiss();
    history.replaceState(null, "", "/");
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={status === "ended" ? "The live session has ended" : status === "removed" ? "You were removed from the session" : "Could not join the live session"}
      description={status === "failed" ? (error ?? "Check the link and your connection.") : shared ? "You can keep a copy of the project in your own projects." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          {shared && (
            <Button
              variant="primary"
              onClick={() => {
                void live.saveCopy().then(() => history.replaceState(null, "", "/"));
              }}
            >
              Save a copy
            </Button>
          )}
        </>
      }
    >
      <span />
    </Dialog>
  );
}

/** Slim bar under the title bar while in a session: role, following, connection. */
export function LiveStrip() {
  const status = useLive((s) => s.status);
  const role = useLive((s) => s.role);
  const following = useLive((s) => s.following);
  const participants = useLive((s) => s.participants);
  const owner = participants.find((p) => p.role === "owner");
  const followed = participants.find((p) => p.id === following);
  if (!ACTIVE.has(status)) return null;
  return (
    <div role="status" className="flex h-7 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 text-xs text-fg-muted">
      <span className="flex items-center gap-1.5 font-medium text-success">
        <span className="size-1.5 rounded-full bg-current" /> Live
      </span>
      <span>
        {participants.length} {participants.length === 1 ? "person" : "people"}
      </span>
      {role === "viewer" && (
        <span className="flex items-center gap-1">
          <Eye className="size-3.5" /> View only{owner ? ` · ${owner.name} is presenting` : ""}
        </span>
      )}
      {status === "waiting" && (
        <span className="flex items-center gap-1.5">
          <Spinner /> Waiting for the owner to share the project…
        </span>
      )}
      {status === "reconnecting" && (
        <span className="flex items-center gap-1.5 text-warning">
          <Spinner /> Reconnecting…
        </span>
      )}
      {status === "connecting" && (
        <span className="flex items-center gap-1.5">
          <Spinner /> Connecting…
        </span>
      )}
      {followed && (
        <span className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5">
            <Avatar person={followed} size={16} /> Following {followed.name}
          </span>
          <button type="button" onClick={() => useLive.getState().follow(null)} className="rounded px-1.5 py-0.5 text-fg-subtle hover:bg-hover hover:text-fg">
            Stop following
          </button>
        </span>
      )}
    </div>
  );
}
