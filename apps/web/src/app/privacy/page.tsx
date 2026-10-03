import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark } from "@/features/workspace/Logo";
import { SITE } from "@/features/seo/pages";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What WriteCode keeps, for how long, and who else sees it: your projects stay in your browser; runs, share links, live sessions and the AI assistant are explained here.",
  alternates: { canonical: "/privacy" },
};

const SECTIONS: { h: string; p: string[] }[] = [
  {
    h: "No account",
    p: ["WriteCode has no sign-up and no account. There is no profile, password or email address to keep."],
  },
  {
    h: "Your projects stay in your browser",
    p: [
      "Projects, files, settings, run history and interviews you set up are saved in this browser (its local storage), not on our servers. Clearing the site's data in your browser deletes them. “Move to another device” sends a copy only when you ask it to.",
      "The browser also keeps a random id that is sent with your runs, so that run limits apply to each person even when many share one network. It is not linked to anything about you.",
    ],
  },
  {
    h: "When you run, debug or visualize a program",
    p: [
      "Your code and its input are sent to our server, run in an isolated sandbox and then thrown away with the sandbox. A record of the run (the language, timings, exit code and the program's output) is kept for 30 days to run the service and find faults, together with a one-way hash of your network address used for rate limits. Your network address itself is not stored with it.",
    ],
  },
  {
    h: "Share links and moving projects",
    p: ["A share link stores a copy of the code you chose to share, for 90 days after it was last opened. Anyone with the link can read that copy. A code to move projects to another device holds a copy of those projects for 12 hours, then it is deleted."],
  },
  {
    h: "Live sessions and interviews",
    p: [
      "In a live session, the code, cursors, runs and names of the people in it are passed between them through our server and kept while the session is active, then removed within a day.",
      "In an interview with the camera on, the video goes directly between the two browsers, or through our relay server when a network blocks direct connections. It is not recorded. Invitations you choose to email are sent through our email provider (Resend).",
    ],
  },
  {
    h: "The AI assistant",
    p: [
      "When you ask the assistant, the files of the open project, its last output and your question are sent to Google's Gemini service to write the answer. We do not store what you send. You can turn the assistant off in Settings → Coding help; nothing is sent to it then.",
    ],
  },
  {
    h: "No advertising, no tracking",
    p: ["WriteCode shows no adverts, uses no tracking cookies and no third-party analytics, and does not sell or share data."],
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-surface-2">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-fg">
            <LogoMark className="size-6" /> {SITE.name}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-[30px] font-bold tracking-tight text-fg">Privacy</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">What {SITE.name} keeps, for how long, and who else sees it.</p>
        {SECTIONS.map((s) => (
          <section key={s.h} className="mt-8">
            <h2 className="text-lg font-semibold text-fg">{s.h}</h2>
            {s.p.map((t, i) => (
              <p key={i} className="mt-2 text-[15px] leading-relaxed text-fg-muted">
                {t}
              </p>
            ))}
          </section>
        ))}
        <p className="mt-10 text-[13px] text-fg-subtle">
          <Link href="/" className="text-accent-ink hover:underline">
            Back to the editor
          </Link>
        </p>
      </main>
    </div>
  );
}
