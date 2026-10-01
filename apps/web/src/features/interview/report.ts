import { getLanguage, type ComplexityEstimate, type InterviewEvent, type InterviewPrivate, type InterviewPublic, type InterviewVerdict, type Project } from "@cw/shared";
import { BRAND_INK, brandRule, drawCodeFile, pageFurniture, rgb, type CodePdfInput } from "@/features/export/code-pdf";
import { formatDuration } from "./monitor";
import { AMBER, GREEN, INK, MUTED, Pdf, RED, pdfNumber, pdfSafe, roundRectPath, textWidth } from "./pdf";
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
    case "camera-on":
      return `${who}'s camera and microphone are on`;
    case "camera-off":
      return `${who}'s camera is off${e.detail ? `: ${e.detail.replace(/^./, (c) => c.toLowerCase())}` : ""}`;
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
export const WARN = new Set<InterviewEvent["kind"]>(["tab-hidden", "blur", "fullscreen-exit", "paste", "blocked", "camera-off"]);

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
${last?.timeMs !== undefined ? row("Runtime (slowest test)", `${last.timeMs} ms`) : ""}
${last?.memoryBytes ? row("Memory", esc(megabytes(last.memoryBytes))) : ""}
${row("Complexity (estimate)", r.complexity ? `<span class="pill">Time ${esc(r.complexity.time)}</span> <span class="pill">Space ${esc(r.complexity.space)}</span><br>${esc(r.complexity.explanation)}` : "Not analysed")}
${r.complexity?.approach ? row("Approach", `${esc(r.complexity.approach)}${r.complexity.suggested && r.complexity.suggested !== r.complexity.approach ? ` (suggested: ${esc(r.complexity.suggested)})` : ""}`) : ""}
${r.complexity?.keyIdea ? row("Key idea", esc(r.complexity.keyIdea)) : ""}
${r.complexity?.consider ? row("Follow-up to ask", esc(r.complexity.consider)) : ""}
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

export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;

type Rgb = [number, number, number];
const SOFT_GREEN: Rgb = [0.91, 0.97, 0.92];
const SOFT_RED: Rgb = [0.99, 0.93, 0.93];
const SOFT_AMBER: Rgb = [1, 0.96, 0.87];
const CARD: Rgb = [0.965, 0.968, 0.985];

/** A filled box with rounded corners; `top` from the top of the page. */
function roundBox(pdf: Pdf, x: number, top: number, width: number, height: number, color: Rgb, r = 7) {
  pdf.raw(`${rgb(color, "rg")} ${roundRectPath(x, pdf.height - top - height, width, height, r)} f`);
}

/** A section's title: a violet mark, the title, a hairline. Never left alone at the foot of a page. */
function section(pdf: Pdf, title: string) {
  pdf.need(60);
  pdf.y += 16;
  roundBox(pdf, pdf.margin, pdf.y + 1, 3.2, 12, BRAND_INK, 1.6);
  pdf.line(title, pdf.margin + 10, { font: "bold", size: 12.5 });
  pdf.y += 19;
  pdf.rule([0.9, 0.9, 0.94]);
  pdf.y += 9;
}

/** A number that matters, on a card: the value large, what it is under it. */
function statCard(pdf: Pdf, x: number, top: number, width: number, value: string, label: string, color: Rgb = INK) {
  roundBox(pdf, x, top, width, 48, CARD);
  const y = pdf.y;
  pdf.y = top + 9;
  pdf.line(value, x + 11, { font: "bold", size: 14, color });
  pdf.y = top + 30;
  pdf.line(label, x + 11, { size: 8, color: MUTED });
  pdf.y = y;
}

/**
 * The report as a PDF to hand to a hiring panel: a framed page with the
 * product's mark, the result and the numbers that matter first, then the
 * integrity signals, the analysis, the tests, the notes, the problem, the code
 * handed in (coloured, with line numbers) and the timeline.
 */
export function buildReportPdf(r: ReportInput & { logo?: CodePdfInput["logo"] }): Uint8Array {
  const iv = r.interview;
  const sum = summarize(r.priv.events);
  const last = iv.verdicts?.at(-1);
  const took = iv.startedAt ? (iv.endedAt ?? Date.now()) - iv.startedAt : undefined;
  const pdf = new Pdf();
  const flag = (count: number) => (count > 0 ? AMBER : INK);
  const candidate = iv.candidate ?? "Candidate";
  const hiddenPassed = r.hidden?.filter((h) => h.comparison.verdict === "passed").length ?? 0;

  // The title block.
  pdf.y = 44;
  const textX = pdf.margin + (r.logo ? 40 : 0);
  if (r.logo) pdf.raw(`q 30 0 0 30 ${pdfNumber(pdf.margin)} ${pdfNumber(pdf.height - pdf.y - 33)} cm /Im1 Do Q`);
  pdf.line("INTERVIEW REPORT", textX, { font: "bold", size: 8, color: BRAND_INK });
  pdf.y += 12;
  pdf.line(pdfSafe(iv.title).slice(0, 56), textX, { font: "bold", size: 18 });
  pdf.y += 24;
  pdf.line(`${candidate}  ·  interviewed by ${r.interviewer || "the interviewer"}  ·  ${iv.startedAt ? new Date(iv.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "not started"}`, textX, { size: 9.5, color: MUTED });
  pdf.y += 19;
  brandRule(pdf);
  pdf.y += 14;

  // The result, first and large: it is what the reader came for.
  {
    const good = last?.status === "accepted";
    const color = !last ? MUTED : good ? GREEN : last.status === "error" ? AMBER : RED;
    const top = pdf.y;
    roundBox(pdf, pdf.margin, top, pdf.inner, 52, !last ? CARD : good ? SOFT_GREEN : last.status === "error" ? SOFT_AMBER : SOFT_RED);
    roundBox(pdf, pdf.margin, top, 4, 52, color, 2);
    pdf.y = top + 11;
    pdf.line(last ? VERDICT[last.status] : "Nothing was submitted", pdf.margin + 16, { font: "bold", size: 15, color });
    pdf.y = top + 32;
    const score = !last
      ? "No code was checked against the tests."
      : last.total && last.status !== "compile-error" && last.status !== "error"
        ? `${last.passed} of ${last.total} tests passed`
        : last.status === "compile-error"
          ? "The code did not compile, so no test ran"
          : (last.message ?? "");
    pdf.line(last ? `${score}  -  ${last.final ? "the code handed in at the end" : "latest submission"}` : score, pdf.margin + 16, { size: 9.5, color: MUTED });
    // The interviewer's rating, on the right.
    const rating = r.priv.rating ? `${r.priv.rating} out of 5` : "Not rated";
    pdf.y = top + 11;
    pdf.line("RATING", pdf.margin + pdf.inner - 14 - textWidth("RATING", "bold", 7.5), { font: "bold", size: 7.5, color: MUTED });
    pdf.y = top + 24;
    pdf.line(rating, pdf.margin + pdf.inner - 14 - textWidth(rating, "bold", 12), { font: "bold", size: 12, color: r.priv.rating ? INK : MUTED });
    pdf.y = top + 62;
  }

  // The numbers that matter, side by side.
  {
    const gap = 8;
    const width = (pdf.inner - 3 * gap) / 4;
    const top = pdf.y;
    const tests = last?.total && last.status !== "compile-error" && last.status !== "error" ? `${last.passed} / ${last.total}` : r.hidden ? `${hiddenPassed} / ${r.hidden.length}` : "-";
    const allPassed = last?.status === "accepted" || (!!r.hidden?.length && hiddenPassed === r.hidden.length);
    statCard(pdf, pdf.margin, top, width, tests, "Tests passed", tests === "-" ? MUTED : allPassed ? GREEN : RED);
    statCard(pdf, pdf.margin + (width + gap), top, width, took !== undefined ? formatDuration(took) : "-", `Time used, of ${iv.durationMin} min`);
    statCard(pdf, pdf.margin + 2 * (width + gap), top, width, String(sum.submissions), "Submissions");
    statCard(pdf, pdf.margin + 3 * (width + gap), top, width, String(iv.leaves ?? 0), iv.maxLeaves ? `Left the window (limit ${iv.maxLeaves})` : "Left the window", flag(iv.leaves ?? 0));
    pdf.y = top + 54;
  }

  section(pdf, "Summary");
  pdf.row("Candidate", iv.candidate ?? "-");
  pdf.row("Interviewer", r.interviewer || "-");
  pdf.row("Language", getLanguage(r.project.language)?.name ?? r.project.language);
  pdf.row("Started", iv.startedAt ? new Date(iv.startedAt).toLocaleString() : "Not started");
  pdf.row("Time used", took !== undefined ? `${formatDuration(took)} of ${iv.durationMin} min` : "-");
  if (iv.endReason) pdf.row("Ended", iv.endReason);
  pdf.row("Submissions", String(sum.submissions));
  if (r.hidden) pdf.row("Hidden tests", `${hiddenPassed} of ${r.hidden.length} passed`, hiddenPassed === r.hidden.length ? GREEN : RED);
  else if (r.hiddenCompileError) pdf.row("Hidden tests", "Did not compile", RED);
  if (last?.timeMs !== undefined) pdf.row("Runtime (slowest test)", `${last.timeMs} ms`);
  if (last?.memoryBytes) pdf.row("Memory", megabytes(last.memoryBytes));
  pdf.row("Rating", r.priv.rating ? `${r.priv.rating} out of 5` : "Not rated");

  section(pdf, "Integrity");
  pdf.row("Left the window", `${iv.leaves ?? 0} time(s)${iv.maxLeaves ? ` (the interview ends at ${iv.maxLeaves})` : ""}`, flag(iv.leaves ?? 0));
  pdf.row("Tab switches", `${sum.tabSwitches}`, flag(sum.tabSwitches));
  pdf.row("Window switches", `${sum.windowSwitches}`, flag(sum.windowSwitches));
  pdf.row("Left full screen", `${sum.fullscreenExits}`, flag(sum.fullscreenExits));
  pdf.row("Total time away", formatDuration(sum.awayMs), flag(sum.awayMs > 30_000 ? 1 : 0));
  pdf.row("Paste attempts (blocked)", `${sum.pastes} (${sum.pastedChars} characters)`, flag(sum.pastes));
  pdf.row("Blocked tool attempts", `${sum.blocked}`, flag(sum.blocked));
  pdf.row("Runs", `${sum.runs}`);
  pdf.space(2);
  pdf.text("Copy, cut and paste were turned off for the candidate. Signals come from the candidate's browser; a second device cannot be seen.", { size: 8.5, color: MUTED, after: 2 });

  if (r.complexity) {
    const c = r.complexity;
    section(pdf, "Analysis (estimate)");
    pdf.text(c.explanation, { size: 9.5, color: MUTED, after: 5 });
    pdf.row("Time complexity", c.time);
    pdf.row("Space complexity", c.space);
    if (c.approach) pdf.row("Approach", c.approach);
    if (c.suggested && c.suggested !== c.approach) pdf.row("Suggested approach", c.suggested);
    if (c.keyIdea) pdf.row("Key idea", c.keyIdea);
    if (c.consider) pdf.row("Follow-up to ask", c.consider);
    if (r.growth?.label) pdf.row("Measured growth (rough)", `${r.growth.label} (time grows like size^${r.growth.exponent})`);
  }

  if (r.hidden?.length) {
    section(pdf, "Hidden tests");
    r.hidden.forEach((h, i) => {
      const ok = h.comparison.verdict === "passed";
      pdf.row(`Hidden test ${i + 1}`, `${ok ? "Passed" : h.comparison.verdict === "failed" ? "Wrong answer" : h.comparison.verdict}${h.run?.executionTime !== undefined ? `  -  ${h.run.executionTime} ms` : ""}${h.test.note ? `  -  ${h.test.note}` : ""}`, ok ? GREEN : RED);
    });
  }

  section(pdf, "Interviewer notes");
  pdf.text(r.priv.notes.trim() || "No notes.", { color: r.priv.notes.trim() ? INK : MUTED });

  section(pdf, "Problem");
  pdf.text(iv.statement.trim() || "(no statement)", { size: 9.5 });

  section(pdf, "Final code");
  pdf.y += 2;
  for (const f of r.project.files) drawCodeFile(pdf, f, r.project.language);

  section(pdf, "Timeline");
  if (!r.priv.events.length) pdf.text("No activity recorded.", { color: MUTED });
  for (const e of r.priv.events) {
    const when = iv.startedAt && e.t >= iv.startedAt ? `+${formatDuration(e.t - iv.startedAt)}` : new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const what = describeEvent(e) + (e.kind === "paste" && e.detail ? `: "${e.detail.replace(/\s+/g, " ").slice(0, 160)}"` : "");
    pdf.need(14);
    const top = pdf.y;
    const warn = WARN.has(e.kind);
    pdf.line(when, pdf.margin, { size: 9, color: MUTED });
    // A mark on the line: amber for what deserves a look.
    roundBox(pdf, pdf.margin + 76, top + 3.2, 4, 4, warn ? AMBER : [0.78, 0.8, 0.86], 2);
    pdf.text(what, { size: 9, indent: 88, color: warn ? AMBER : INK, leading: 1.45 });
    if (pdf.y === top) pdf.space(13);
  }

  const name = `Interview report  -  ${candidate}`;
  return pdf.build((index, total) => pageFurniture(pdf, name, !!r.logo, index, total), r.logo);
}

const fileName = (name: string, ext: string) => `interview-${name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "report"}.${ext}`;

function save(data: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Saves the report as a PDF. */
export function downloadPdf(pdf: Uint8Array, name: string) {
  save(pdf as Uint8Array<ArrayBuffer>, "application/pdf", fileName(name, "pdf"));
}

/**
 * Saves the report as a Word document: the report page with the markers Word
 * reads, in a .doc file that Word, Google Docs and LibreOffice open and edit.
 */
export function downloadWord(html: string, name: string) {
  const doc = html
    .replace("<html lang=\"en\">", '<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">')
    .replace("<head>", "<head><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->");
  save(`\ufeff${doc}`, "application/msword", fileName(name, "doc"));
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
