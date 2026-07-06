"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyTheme, readThemeCookie, THEMES } from "@/lib/theme";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEME_META: Record<Theme, { label: string; icon: typeof Sun }> = {
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
  system: { label: "System", icon: Monitor }
};

/**
 * A three-way light/dark/system segmented control. Renders all three buttons
 * at fixed width from the first paint (the active highlight appears after
 * mount), so switching themes never shifts the sidebar layout.
 */
export function ThemeToggle({ className }: { className?: string }) {
  // undefined until mounted: the server cannot know the cookie-less
  // ("system") resolution, so the highlight is deferred to the client.
  const [theme, setTheme] = useState<Theme | undefined>(undefined);

  useEffect(() => {
    setTheme(readThemeCookie());
  }, []);

  // While "system" is selected, follow live OS theme changes.
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const select = (next: Theme): void => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={cn("border-border/60 inline-flex items-center gap-0.5 rounded-lg border p-0.5", className)}
    >
      {THEMES.map((option) => {
        const { label, icon: Icon } = THEME_META[option];
        const active = theme === option;
        return (
          <Tooltip key={option}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`${label} theme`}
                onClick={() => select(option)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-md transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label} theme</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
