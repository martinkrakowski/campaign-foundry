import type { ReactNode } from "react";
import { Inter, Fira_Code } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const firaCode = Fira_Code({ subsets: ["latin"], variable: "--font-fira-code", display: "swap" });

export const metadata = {
  title: "Campaign Foundry — HITL Orchestrator",
  description: "Human-in-the-loop review for automated social ad creatives",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark h-full ${inter.variable} ${firaCode.variable}`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
