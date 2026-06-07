import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Campaign Foundry — Creative Review",
  description: "Human-in-the-loop review for automated social ad creatives",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
