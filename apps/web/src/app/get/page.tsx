import type { Metadata } from "next";
import { ReceivePage } from "@/features/export/SharePages";

export const metadata: Metadata = {
  title: "Bring your projects to this device",
  robots: { index: false, follow: false },
};

/** Opened by scanning the code another browser showed: `/get#<id>`. */
export default function GetPage() {
  return <ReceivePage />;
}
