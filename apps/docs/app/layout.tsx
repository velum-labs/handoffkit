import "./global.css";

import type { ReactNode } from "react";

import { RootProvider } from "fumadocs-ui/provider";

export const metadata = {
  title: {
    template: "%s | fusionkit",
    default: "fusionkit — real model fusion behind your coding agent"
  },
  description:
    "Documentation for fusionkit (@fusionkit/cli): spin up a panel of models, fuse their answers, and back Codex, Claude Code, or Cursor."
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
