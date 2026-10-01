import {
  Cascadia_Code,
  Fira_Code,
  Geist_Mono,
  IBM_Plex_Mono,
  Inconsolata,
  Inter,
  JetBrains_Mono,
  Red_Hat_Mono,
  Roboto_Mono,
  Source_Code_Pro,
  Space_Mono,
  Ubuntu_Mono,
  Victor_Mono,
} from "next/font/google";

/**
 * The interface font and the code fonts people can choose in Settings. Each
 * code font is a CSS variable named `--font-code-<id>` (the ids are listed in
 * features/settings/fonts.ts). Only the default is fetched with the page; the
 * others are fetched by the browser when one is first used.
 */
const ui = Inter({ variable: "--font-ui", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-code-jetbrains", subsets: ["latin"] });
const fira = Fira_Code({ variable: "--font-code-fira", subsets: ["latin"], preload: false });
const cascadia = Cascadia_Code({ variable: "--font-code-cascadia", subsets: ["latin"], preload: false });
const sourceCode = Source_Code_Pro({ variable: "--font-code-source", subsets: ["latin"], preload: false });
const plex = IBM_Plex_Mono({ variable: "--font-code-plex", subsets: ["latin"], weight: ["400", "500", "700"], preload: false });
const roboto = Roboto_Mono({ variable: "--font-code-roboto", subsets: ["latin"], preload: false });
const geist = Geist_Mono({ variable: "--font-code-geist", subsets: ["latin"], preload: false });
const ubuntu = Ubuntu_Mono({ variable: "--font-code-ubuntu", subsets: ["latin"], weight: ["400", "700"], preload: false });
const inconsolata = Inconsolata({ variable: "--font-code-inconsolata", subsets: ["latin"], preload: false });
const victor = Victor_Mono({ variable: "--font-code-victor", subsets: ["latin"], preload: false });
const redHat = Red_Hat_Mono({ variable: "--font-code-redhat", subsets: ["latin"], preload: false });
const space = Space_Mono({ variable: "--font-code-space", subsets: ["latin"], weight: ["400", "700"], preload: false });

/** The classes that define every font's variable, for the root element. */
export const FONT_VARIABLES = [ui, jetbrains, fira, cascadia, sourceCode, plex, roboto, geist, ubuntu, inconsolata, victor, redHat, space].map((f) => f.variable).join(" ");
