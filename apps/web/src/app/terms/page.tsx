import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/features/seo/LegalPage";
import { SITE } from "@/features/seo/pages";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The rules for using WriteCode: what you may run, who owns your code, fair use of the sandboxes, share links, live sessions, the AI assistant and the limits of the service.",
  alternates: { canonical: "/terms" },
};

const SECTIONS: LegalSection[] = [
  {
    h: "Using WriteCode",
    p: [
      `${SITE.name} is a free online editor where you can write, run, debug, visualize, test and share code. By using the site you agree to these terms. If you do not agree, please do not use it.`,
      "There is no account. You may use the site if you are old enough to agree to these terms where you live; anyone younger should use it with a parent's, guardian's or teacher's permission.",
    ],
  },
  {
    h: "Your code is yours",
    p: [
      "You keep every right to the code and text you write. We do not claim ownership of it. To run, debug, share or explain your code we need to send it to our servers and to the services described in the Privacy notice; you allow us to do only that, and only for as long as it takes.",
      "Do not paste code or data you are not allowed to use, and do not put passwords, keys or personal information about other people into programs you run or share.",
    ],
  },
  {
    h: "What you may not do",
    p: [
      "Run or share programs meant to attack, scan or overload other computers or networks; to mine cryptocurrency; to send spam; or to get around the sandbox, its limits or the site's security.",
      "Use share links, live sessions or interview invitations to publish or send anything unlawful, hateful, harassing, sexually explicit involving minors, or infringing someone else's rights.",
      "Use automated tools to send runs in bulk, or resell access to the service.",
      "We may block requests, end sessions, delete share links or limit access from a network when these rules are broken or the service is put at risk.",
    ],
  },
  {
    h: "Fair use and limits",
    p: [
      "Programs run in isolated sandboxes with limits on time, memory, output and how many runs you can make at once and per minute. The limits are there so that the service stays fast and free for everyone, and they may change.",
    ],
  },
  {
    h: "Share links, live sessions and interviews",
    p: [
      "Anyone who has a share link can read the code it holds, and anyone with a live-session link can join that session. You choose who receives them. Share links are kept for 90 days after they were last opened; you can ask us to remove one sooner.",
      "An interview report is a record for the person who ran the interview. Tell the candidate before the interview that their code and activity are being observed.",
    ],
  },
  {
    h: "The AI assistant",
    p: [
      "The assistant's answers are written by an AI model and can be wrong, incomplete or insecure. Check them before you rely on them. You can turn the assistant off in Settings.",
    ],
  },
  {
    h: "No guarantee",
    p: [
      `${SITE.name} is provided as it is, free of charge, without any promise that it will always be available, free of faults, or right for a particular purpose. Projects are saved in your browser: keep your own copy (Download) of anything that matters, because clearing your browser's data deletes them.`,
      "As far as the law allows, we are not liable for lost data, lost work or any indirect loss that comes from using the site.",
    ],
  },
  {
    h: "Changes",
    p: ["We may update these terms when the site changes. The date at the top shows the latest version; using the site after a change means you accept the new terms."],
  },
];

export default function TermsPage() {
  return <LegalPage title="Terms of use" intro={`The rules for using ${SITE.name}, in plain words.`} updated="3 October 2026" sections={SECTIONS} />;
}
