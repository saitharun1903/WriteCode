import type { Metadata } from "next";

/**
 * Ownership codes from Google Search Console and Bing Webmaster Tools (the
 * "HTML tag" method: the content="..." value). They are public by design:
 * they only prove who owns the site. Paste each code between the quotes.
 */
const GOOGLE = "";
const BING = "";

export const SITE_VERIFICATION: Metadata["verification"] = {
  ...(GOOGLE ? { google: GOOGLE } : {}),
  ...(BING ? { other: { "msvalidate.01": BING } } : {}),
};
