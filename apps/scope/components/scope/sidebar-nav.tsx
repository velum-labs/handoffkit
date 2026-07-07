"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, Cpu, Layers, Scale } from "lucide-react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

const NAV = [
  { href: "/", label: "Sessions", icon: Boxes },
  { href: "/models", label: "Models", icon: Cpu },
  { href: "/judge", label: "Judge", icon: Scale },
  { href: "/environments", label: "Environments", icon: Layers }
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/sessions");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Sidebar navigation with an active-route highlight and collapsed tooltips. */
export function SidebarNav() {
  const pathname = usePathname();
  return (
    <SidebarMenu>
      {NAV.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton asChild isActive={isActive(pathname, item.href)} tooltip={item.label}>
            <Link href={item.href}>
              <item.icon />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
