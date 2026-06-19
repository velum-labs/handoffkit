import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SidebarNav } from "@/components/scope/sidebar-nav";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "scope — fusion observability",
  description: "Live observability for the FusionKit + HandoffKit + Cursorkit stack"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("dark", geist.variable, geistMono.variable)}>
      <body className="antialiased">
        <TooltipProvider delayDuration={200}>
          <div className="flex h-screen overflow-hidden">
            <aside className="bg-sidebar text-sidebar-foreground flex w-60 shrink-0 flex-col overflow-y-auto border-r p-5">
              <div className="flex items-center gap-2">
                <span className="bg-primary inline-block size-2.5 rounded-full" />
                <div>
                  <div className="text-base font-semibold tracking-tight">scope</div>
                  <div className="text-muted-foreground text-xs">fusion observability</div>
                </div>
              </div>
              <Separator className="my-5" />
              <SidebarNav />
              <div className="text-muted-foreground mt-auto pt-8 text-[11px] leading-relaxed">
                Tails the fusion-trace event spine across FusionKit, HandoffKit, and Cursorkit.
              </div>
            </aside>
            <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
