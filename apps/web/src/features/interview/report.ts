import type { ComplexityEstimate, InterviewEvent, InterviewPrivate, InterviewPublic, InterviewVerdict, Project } from "@cw/shared";
import { formatDuration } from "./monitor";
import type { Growth, HiddenResult } from "./store";

export interface ActivitySummary {
  tabSwitches: number;
  windowSwitches: number;
  /** Total time away from the tab or window, ms. */
  awayMs: number;
  fullscreenExits: number;
  pastes: number;
  pastedChars: number;
  /** Pastes of 80+ characters: the ones worth a look. */
  largePastes: number;
  runs: number;
  blocked: number;
  submissions: number;
}

export function summarize(events: InterviewEvent[]): ActivitySummary {
  const s: ActivitySummary = { tabSwitches: 0, windowSwitches: 0, awayMs: 0, fullscreenExits: 0, pastes: 0, pastedChars: 0, largePastes: 0, runs: 0, blocked: 0, submissions: 0 };
  for (const e of events) {
    if (e.kind === "tab-hidden") s.tabSwitches++;
    if (e.kind === "blur") s.windowSwitches++;
    if ((e.kind === "tab-visible" || e.kind === "focus") && e.awayMs) s.awayMs += e.awayMs;
    if (e.kind === "fullscreen-exit") s.fullscreenExits++;
    if (e.kind === "paste") {
      s.pastes++;
      s.pastedChars += e.chars ?? 0;
      if ((e.chars ?? 0) >= 80) s.largePastes++;
    }
    if (e.kind === "run") s.runs++;
    if (e.kind === "blocked") s.blocked++;
    if (e.kind === "submit") s.submissions++;
  }
  return s;
}

/** One line describing an activity entry, for the timeline. */
export function describeEvent(e: InterviewEvent): string {
  const who = e.who ?? "The candidate";
  switch (e.kind) {
    case "joined":
      return `${who} joined`;
    case "left":
      return `${who} disconnected`;
    case "consent":
      return `${who} agreed to the interview rules`;
    case "started":
      return `The clock started (${e.detail ?? ""})`;
    case "tab-hidden":
      return `${who} left the tab`;
    case "tab-visible":
      return `${who} came back to the tab${e.awayMs !== undefined ? ` after ${formatDuration(e.awayMs)}` : ""}`;
    case "blur":
      return `${who} switched to another window`;
    case "focus":
      return `${who} came back to the window${e.awayMs !== undefined ? ` after ${formatDuration(e.awayMs)}` : ""}`;
    case "fullscreen-exit":
      return `${who} left full screen`;
    case "fullscreen-enter":
      return `${who} went back to full screen`;
    case "paste":
      return `${who} tried to paste ${e.chars ?? 0} characters (blocked)`;
    case "run":
      return `${who} ran ${e.detail || "the program"}`;
    case "run-result":
      return e.detail ?? "Run finished";
    case "submit":
      return e.who ? `${e.who} submitted. ${e.detail ?? ""}` : `The code handed in was checked. ${e.detail ?? ""}`;
    case "blocked":
      return `${who} tried to use the ${e.detail ?? "a blocked tool"} (blocked)`;
    case "extended":
      return `Time extended (${e.detail ?? ""})`;
    case "ended":
      return `The interview ended: ${e.detail ?? ""}`;
  }
}

const VERDICT: Record<InterviewVerdict["status"], string> = {
  accepted: "Accepted",
  "wrong-answer": "Wrong answer",
  "runtime-error": "Runtime error",
  "time-limit": "Time limit exceeded",
  "compile-error": "Did not compile",
  error: "Could not be checked",
};

/** Events that deserve the interviewer's attention. */
export const WARN = new Set<InterviewEvent["kind"]>(["tab-hidden", "blur", "fullscreen-exit", "paste", "blocked"]);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const clock = (t: number, start?: number) => {
  const time = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return start && t >= start ? `${time} (+${formatDuration(t - start)})` : time;
};

export interface ReportInput {
  interview: InterviewPublic;
  priv: InterviewPrivate;
  interviewer: string;
  project: Project;
  hidden: HiddenResult[] | null;
  hiddenCompileError?: string;
  complexity?: ComplexityEstimate;
  growth?: Growth;
}

/** A self-contained HTML report (opens in any browser, prints to PDF) for HR and hiring panels. */
export function buildReport(r: ReportInput): string {
  const iv = r.interview;
  const sum = summarize(r.priv.events);
  const passed = r.hidden?.filter((h) => h.comparison.verdict === "passed").length ?? 0;
  const last = iv.verdicts?.at(-1);
  const took = iv.startedAt ? (iv.endedAt ?? Date.now()) - iv.startedAt : undefined;
  const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  const stars = r.priv.rating ? "★".repeat(r.priv.rating) + "☆".repeat(5 - r.priv.rating) : "Not rated";
  const hiddenRows = (r.hidden ?? [])
    .map((h, i) => `<tr><td>Hidden ${i + 1}</td><td class="${h.comparison.verdict === "passed" ? "ok" : "bad"}">${esc(h.comparison.verdict)}</td><td>${h.run?.executionTime ?? "–"} ms</td></tr>`)
    .join("");
  const timeline = r.priv.events
    .map((e) => `<tr class="${WARN.has(e.kind) ? "warn" : ""}"><td class="t">${esc(clock(e.t, iv.startedAt))}</td><td>${esc(describeEvent(e))}${e.kind === "paste" && e.detail ? `<pre>${esc(e.detail)}</pre>` : ""}</td></tr>`)
    .join("");
  const files = r.project.files.map((f) => `<h3>${esc(f.path)}</h3><pre class="code">${esc(f.content)}</pre>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Interview report: ${esc(iv.candidate ?? "candidate")} · ${esc(iv.title)}</title>
<style>
body{font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;color:#1f2328;max-width:900px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #e3e5e8;padding-bottom:6px}h3{font-size:14px;margin:16px 0 6px}
.muted{color:#6b727c}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef0f2;vertical-align:top}
th{width:34%;font-weight:600;color:#3d434b}.ok{color:#1a7f37;font-weight:600}.bad{color:#cf222e;font-weight:600}.warn td{background:#fff8e6}
td.t{white-space:nowrap;width:1%;color:#6b727c}pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border-radius:6px;padding:8px;margin:6px 0 0;font:12px/1.5 ui-monospace,Consolas,monospace}
.code{border:1px solid #e3e5e8}.note{white-space:pre-wrap}.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef3ff;color:#1f4fb8;font-weight:600}
@media print{body{margin:0}}
</style></head><body>
<p class="muted">WriteCode interview report · generated ${esc(new Date().toLocaleString())}</p>
<h1>${esc(iv.title)}</h1>
<h2>Summary</h2><table>
${row("Candidate", esc(iv.candidate ?? "–"))}
${row("Interviewer", esc(r.interviewer))}
${row("Language", esc(r.project.language))}
${row("Started", iv.startedAt ? esc(new Date(iv.startedAt).toLocaleString()) : "Not started")}
${row("Time used", took !== undefined ? `${esc(formatDuration(took))} of ${iv.durationMin} min` : "–")}
${last ? row(last.final ? "Code handed in" : "Latest submission", `<span class="${last.status === "accepted" ? "ok" : "bad"}">${esc(VERDICT[last.status])}</span>${last.total && last.status !== "compile-error" && last.status !== "error" ? ` · ${last.passed} / ${last.total} tests passed` : ""}`) : ""}
${iv.endReason ? row("Ended", esc(iv.endReason)) : ""}
${row("Hidden tests", r.hidden ? `<span class="${passed === r.hidden.length ? "ok" : "bad"}">${passed} / ${r.hidden.length} passed</span>` : r.hiddenCompileError ? '<span class="bad">Did not compile</span>' : "Not run")}
${row("Complexity (estimate)", r.complexity ? `<span class="pill">Time ${esc(r.complexity.time)}</span> <span class="pill">Space ${esc(r.complexity.space)}</span><br>${esc(r.complexity.explanation)}` : "Not analysed")}
${r.growth?.label ? row("Measured growth (rough)", `${esc(r.growth.label)} · time ∝ size<sup>${r.growth.exponent}</sup>`) : ""}
${row("Rating", esc(stars))}
</table>
<h2>Integrity signals</h2><table>
${row("Left the tab", `${sum.tabSwitches} time(s)`)}
${row("Switched window", `${sum.windowSwitches} time(s)`)}
${row("Total time away", esc(formatDuration(sum.awayMs)))}
${row("Left full screen", `${sum.fullscreenExits} time(s)`)}
${row("Left the window in all", `${iv.leaves ?? 0} time(s)${iv.maxLeaves ? ` (the interview ends at ${iv.maxLeaves})` : ""}`)}
${row("Paste attempts (blocked)", `${sum.pastes} (${sum.pastedChars} characters; ${sum.largePastes} of 80+ characters)`)}
${row("Runs", String(sum.runs))}
${row("Submissions", String(sum.submissions))}
${row("Blocked tool attempts", String(sum.blocked))}
</table>
<p class="muted">Copying from the page and pasting into it were turned off for the candidate. Signals from the candidate's browser. A second device (a phone) cannot be seen; use them with the replay and a video call.</p>
${r.hidden?.length ? `<h2>Hidden tests</h2><table><tr><th>Test</th><th>Result</th><th>Time</th></tr>${hiddenRows}</table>` : ""}
<h2>Interviewer notes</h2><p class="note">${r.priv.notes ? esc(r.priv.notes) : '<span class="muted">No notes.</span>'}</p>
<h2>Problem</h2><pre>${esc(iv.statement || "(no statement)")}</pre>
<h2>Final code</h2>${files}
<h2>Timeline</h2><table>${timeline || '<tr><td class="muted">No activity recorded.</td></tr>'}</table>
</body></html>`;
}

/** Saves the report as an .html file (opens anywhere, prints to PDF). */
export function downloadReport(html: string, name: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `interview-${name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "report"}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Opens the report in a new tab and the browser's print dialog (Save as PDF). */
export function printReport(html: string) {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
}
