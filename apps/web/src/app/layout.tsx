import type { Metadata, Viewport } from "next";
import { PRODUCT } from "@cw/shared";
import "./globals.css";
import { FONT_VARIABLES } from "./fonts";
import { SITE } from "@/features/seo/pages";
import { SITE_VERIFICATION } from "@/features/seo/verification";


export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${PRODUCT.name}: Online Compiler, Debugger & Visualizer (Java, Python, C, C++)`,
    template: `%s | ${PRODUCT.name}`,
  },
  description: PRODUCT.description,
  applicationName: PRODUCT.name,
  keywords: [
    "online compiler",
    "online java compiler",
    "online python compiler",
    "online c compiler",
    "online c++ compiler",
    "online debugger",
    "code visualizer",
    "online ide",
    "run code online",
    "test cases",
    "code together",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: PRODUCT.name,
    title: `${PRODUCT.name}: online compiler, debugger and visualizer`,
    description: PRODUCT.description,
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `${PRODUCT.name}: write, run, debug and share code in your browser` }],
    locale: "en_IN",
  },
  twitter: { card: "summary_large_image", title: `${PRODUCT.name}: online compiler, debugger and visualizer`, description: PRODUCT.description, images: ["/og.png"] },
  robots: { index: true, follow: true },
  // Versioned: browsers keep an icon for a long time by its address, so a new address makes them fetch the W again.
  icons: { icon: [{ url: "/favicon.ico?v=4", sizes: "any" }, { url: "/icon-192.png?v=4", type: "image/png", sizes: "192x192" }], shortcut: "/favicon.ico?v=4", apple: "/apple-touch-icon.png?v=4" },
  verification: SITE_VERIFICATION,
};

export const viewport: Viewport = {
  themeColor: "#f7f8fa",
  // Phones: draw under the notch and home bar (the dock keeps clear with safe-area insets),
  // and let the on-screen keyboard shrink the layout instead of covering the code.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

/** Applies the persisted theme and code font before first paint, so nothing flashes or changes shape. */
const themeScript = `try{var s=JSON.parse(localStorage.getItem("cw:settings")||"{}"),t=s.theme,f=s.codeFont;if(typeof f==="string"&&/^[a-z]+$/.test(f))document.documentElement.style.setProperty("--font-code","var(--font-code-"+f+")");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else if(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.dataset.theme="dark"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="light" className={FONT_VARIABLES} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
