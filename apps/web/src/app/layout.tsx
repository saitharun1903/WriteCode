import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { PRODUCT } from "@cw/shared";
import "./globals.css";

const ui = Inter({ variable: "--font-ui", subsets: ["latin"] });
const code = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"] });

export const metadata: Metadata = {
  title: PRODUCT.name,
  description: PRODUCT.description,
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
};

/** Applies the persisted theme before first paint so there is no light/dark flash. */
const themeScript = `try{var t=JSON.parse(localStorage.getItem("cw:settings")||"{}").theme;if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else if(t==="system"&&matchMedia("(prefers-color-scheme: light)").matches)document.documentElement.dataset.theme="light"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" className={`${ui.variable} ${code.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
