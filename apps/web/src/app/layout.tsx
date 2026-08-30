import type { ReactNode } from "react";
import { Inter, Fira_Code } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const firaCode = Fira_Code({ subsets: ["latin"], variable: "--font-fira-code", display: "swap" });

export const metadata = {
  title: "Campaign Foundry — HITL Orchestrator",
  description: "Human-in-the-loop review for automated social ad creatives",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `dark` is the server's answer, not the user's: the choice lives in localStorage,
    // which a server does not have. The inline script below is the correction, and it is
    // the first thing in the body so it runs before the first paint rather than
    // repairing one. It cannot go in <head>: App Router renders head children into the
    // flight payload but not into the document shell, so they only apply after
    // hydration — which is the flash this exists to prevent.
    // `suppressHydrationWarning` is required, not cosmetic: the script above mutates this
    // element's class list before React hydrates, so the real DOM and the client VDOM
    // legitimately disagree on exactly the attribute the correction rewrites. It suppresses
    // one level only — this element's own attributes — so a genuine mismatch anywhere below
    // still warns.
    <html
      lang="en"
      suppressHydrationWarning
      className={`dark h-full ${inter.variable} ${firaCode.variable}`}
    >
      <body className="h-full">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
