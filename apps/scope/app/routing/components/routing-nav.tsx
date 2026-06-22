"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/routing", label: "Overview" },
  { href: "/routing/providers", label: "Providers" },
  { href: "/routing/scenarios", label: "Scenarios" }
];

/** Sub-navigation for the routing dashboard section. */
export function RoutingNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Routing sections" className="mb-6 flex flex-wrap gap-1">
      {TABS.map((tab) => {
        const active =
          tab.href === "/routing"
            ? pathname === "/routing"
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
