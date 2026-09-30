import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { PRODUCT } from "@cw/shared";
import "./globals.css";
import { SITE } from "@/features/seo/pages";
import { SITE_VERIFICATION } from "@/features/seo/verification";

const ui = Inter({ variable: "--font-ui", subsets: ["latin"] });
const code = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"] });

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
  icons: { icon: [{ url: "/favicon.ico" }, { url: "/icon-192.png", type: "image/png", sizes: "192x192" }], apple: "/apple-touch-icon.png" },
  verification: SITE_VERIFICATION,
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
  // Phones: draw under the notch and home bar (the dock keeps clear with safe-area insets),
  // and let the on-screen keyboard shrink the layout instead of covering the code.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
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
