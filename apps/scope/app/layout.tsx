import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

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

const NAV = [
  { href: "/", label: "Sessions" },
  { href: "/models", label: "Models" },
  { href: "/environments", label: "Environments" }
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("dark", geist.variable, geistMono.variable)}>
      <body className="antialiased">
        <TooltipProvider delayDuration={200}>
          <div className="flex min-h-screen">
            <aside className="bg-sidebar text-sidebar-foreground flex w-60 shrink-0 flex-col border-r p-5">
              <div className="flex items-center gap-2">
                <span className="bg-primary inline-block size-2.5 rounded-full" />
                <div>
                  <div className="text-base font-semibold tracking-tight">scope</div>
                  <div className="text-muted-foreground text-xs">fusion observability</div>
                </div>
              </div>
              <Separator className="my-5" />
              <nav className="flex flex-col gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-3 py-2 text-sm font-medium transition-colors"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <div className="text-muted-foreground mt-auto pt-8 text-[11px] leading-relaxed">
                Tails the fusion-trace event spine across FusionKit, HandoffKit, and Cursorkit.
              </div>
            </aside>
            <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
