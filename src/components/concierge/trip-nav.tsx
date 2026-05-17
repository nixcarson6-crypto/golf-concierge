"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  MessageSquare,
  Compass,
  CalendarRange,
  MapPinned,
  Users,
  CreditCard,
  ScrollText,
} from "lucide-react";

const TABS = [
  { href: "", label: "Concierge", icon: MessageSquare },
  { href: "/destination", label: "Destinations", icon: Compass },
  { href: "/itinerary", label: "Itinerary", icon: CalendarRange },
  { href: "/map", label: "Map", icon: MapPinned },
  { href: "/group", label: "Group", icon: Users },
  { href: "/payments", label: "Payments", icon: CreditCard },
  { href: "/summary", label: "Summary", icon: ScrollText },
];

export function TripNav({ tripId }: { tripId: string }) {
  const pathname = usePathname();
  const base = `/trips/${tripId}`;

  return (
    <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar">
      {TABS.map((tab) => {
        const href = `${base}${tab.href}`;
        const isActive =
          tab.href === ""
            ? pathname === base
            : pathname?.startsWith(href);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={href}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs whitespace-nowrap transition",
              isActive
                ? "bg-surface-raised text-foreground border border-border"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-raised/60 border border-transparent",
            )}
          >
            <Icon className="size-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
