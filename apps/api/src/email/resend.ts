import { config } from "../config.js";

export interface Email {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

/** True when this server can send email (a Resend API key is configured). */
export const emailAvailable = () => config.email.apiKey.length > 0;

/**
 * Sends one email through Resend. Returns an error message for the user, or
 * null. The API key is only ever sent to Resend, in the Authorization header.
 */
export async function sendEmail(email: Email): Promise<string | null> {
  if (!emailAvailable()) return "Email is not set up on this server.";
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${config.email.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.email.from, to: email.to, subject: email.subject, html: email.html, text: email.text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return "The email service could not be reached. Try again in a moment.";
  }
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
  // Logged without addresses or content.
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level: "warn", msg: "email not sent", service: "api", status: res.status, reason: body.name ?? "" }) + "\n");
  if (res.status === 403 || body.name === "validation_error") {
    return "The email could not be sent: the sending domain is not verified yet. Copy the link and share it instead.";
  }
  if (res.status === 429) return "Too many emails right now. Wait a minute and try again.";
  return "The email could not be sent. Copy the link and share it instead.";
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The invitation to a live session or an interview. Names and titles are escaped. */
export function inviteEmail(opts: { from: string; link: string; kind: "live" | "interview"; title?: string; minutes?: number }): Omit<Email, "to"> {
  const from = opts.from;
  const interview = opts.kind === "interview";
  const subject = interview ? `${from} invited you to a coding interview on WriteCode` : `${from} invited you to code together on WriteCode`;
  const lines = interview
    ? [
        `${from} has invited you to a coding interview${opts.title ? `: "${opts.title}"` : ""}.`,
        `${opts.minutes ? `You will have ${opts.minutes} minutes. ` : ""}The clock starts only when you open the link and agree to the rules.`,
        "You will write and run your code in the browser. The interviewer sees your code as you type, your runs, and when you leave the tab or full screen.",
      ]
    : [`${from} is sharing a project live on WriteCode.`, "Open the link to see the code, everyone's cursors and the program's output as they happen. No sign-up needed: just type your name."];
  const button = interview ? "Open the interview" : "Join the live session";
  const text = [...lines, "", opts.link, "", "WriteCode · writecode.in"].join("\n");
  // The mark, from the same site the link opens.
  const logo = new URL("/logo.png", opts.link).href;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e3e5e8">
<tr><td style="padding:28px 32px 8px;font-size:18px;font-weight:700"><img src="${escape(logo)}" width="22" height="22" alt="" style="display:inline-block;width:22px;height:22px;border-radius:5px;vertical-align:-4px;margin-right:8px;border:0">WriteCode</td></tr>
<tr><td style="padding:12px 32px 0;font-size:20px;font-weight:700;line-height:1.3">${escape(subject)}</td></tr>
${lines.map((l) => `<tr><td style="padding:12px 32px 0;font-size:15px;line-height:1.55;color:#3d434b">${escape(l)}</td></tr>`).join("")}
<tr><td style="padding:24px 32px 8px"><a href="${escape(opts.link)}" style="display:inline-block;background:#1f8f4e;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">${button}</a></td></tr>
<tr><td style="padding:8px 32px 28px;font-size:12px;color:#6b727c;word-break:break-all">Or open this link: ${escape(opts.link)}</td></tr>
</table>
<p style="font-size:12px;color:#8a9099;margin:16px 0 0">You got this email because ${escape(from)} entered your address on WriteCode.</p>
</td></tr></table></body></html>`;
  return { subject, html, text };
}
