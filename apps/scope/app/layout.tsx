import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";

import { SidebarNav } from "@/components/scope/sidebar-nav";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "scope — fusion observability",
  description: "Live observability for the FusionKit + HandoffKit + Cursorkit stack"
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <html lang="en" className={cn("dark", geist.variable, geistMono.variable)}>
      <body className="antialiased">
        <TooltipProvider delayDuration={200}>
          <SidebarProvider defaultOpen={defaultOpen}>
            <Sidebar collapsible="icon">
              <SidebarHeader>
                <div className="flex items-center gap-2 px-1 py-1">
                  <span className="bg-primary inline-block size-2.5 shrink-0 rounded-full" />
                  <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                    <div className="truncate text-base font-semibold tracking-tight">scope</div>
                    <div className="text-muted-foreground truncate text-xs">fusion observability</div>
                  </div>
                </div>
              </SidebarHeader>
              <SidebarContent>
                <SidebarGroup>
                  <SidebarNav />
                </SidebarGroup>
              </SidebarContent>
              <SidebarFooter>
                <div className="text-muted-foreground px-1 pb-1 text-[11px] leading-relaxed group-data-[collapsible=icon]:hidden">
                  Tails the fusion-trace event spine across FusionKit, HandoffKit, and Cursorkit.
                </div>
              </SidebarFooter>
              <SidebarRail />
            </Sidebar>
            <SidebarInset className="min-w-0 overflow-x-hidden">{children}</SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
