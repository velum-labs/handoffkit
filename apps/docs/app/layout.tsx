import "./global.css";

import type { ReactNode } from "react";

import { RootProvider } from "fumadocs-ui/provider";

import type { Metadata } from "next";

const title = "fusionkit: real model fusion behind your coding agent";
const description =
  "Documentation for fusionkit (@fusionkit/cli): run a panel of models behind Codex, Claude Code, or Cursor, and let a judge synthesize the answer your agent runs.";

export const metadata: Metadata = {
  metadataBase: new URL("https://fusionkit.velum-labs.com"),
  title: {
    template: "%s | fusionkit",
    default: title
  },
  description,
  openGraph: {
    type: "website",
    siteName: "fusionkit",
    title,
    description
  },
  twitter: {
    card: "summary_large_image",
    title,
    description
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
