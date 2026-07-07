import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";

import { SidebarNav } from "@/components/scope/sidebar-nav";
import { ThemeToggle } from "@/components/scope/theme-toggle";
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
import { isTheme, THEME_COOKIE, THEME_INIT_SCRIPT } from "@/lib/theme";
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
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const theme = isTheme(themeCookie) ? themeCookie : "system";

  return (
    // Explicit themes render server-side (no flash); "system" is resolved by
    // the inline script below before first paint, hence suppressHydrationWarning.
    <html
      lang="en"
      className={cn(theme === "dark" && "dark", geist.variable, geistMono.variable)}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
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
                <div className="px-1 pb-1 group-data-[collapsible=icon]:hidden">
                  <ThemeToggle className="mb-2" />
                  <div className="text-muted-foreground text-[11px] leading-relaxed">
                    Tails the fusion-trace event spine across FusionKit, HandoffKit, and Cursorkit.
                  </div>
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
