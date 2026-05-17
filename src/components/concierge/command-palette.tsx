"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Compass,
  CalendarRange,
  Users,
  CreditCard,
  ScrollText,
  Send,
  Check,
  Search,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type Snapshot = {
  trip: { id: string };
  me: { role: "OWNER" | "MEMBER" | "ADMIN" };
  itinerary: { id: string; status: string } | null;
};

type Command = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string;
  perform: () => void;
};

/**
 * ⌘K / Ctrl+K palette. The single power-user surface — keeps the rest of the
 * UI clean. Includes navigation, "tell the concierge" pass-through, and the
 * one-click approve action.
 */
export function CommandPalette({
  snapshot,
  onSendMessage,
  onApprove,
}: {
  snapshot: Snapshot;
  onSendMessage: (text: string) => void;
  onApprove: () => Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tripBase = `/trips/${snapshot.trip.id}`;

  const commands: Command[] = React.useMemo(() => {
    const cmds: Command[] = [
      {
        id: "open-concierge",
        label: "Concierge",
        icon: Sparkles,
        perform: () => router.push(tripBase),
      },
      {
        id: "open-destinations",
        label: "Destinations",
        icon: Compass,
        perform: () => router.push(`${tripBase}/destination`),
      },
      {
        id: "open-itinerary",
        label: "Itinerary",
        icon: CalendarRange,
        perform: () => router.push(`${tripBase}/itinerary`),
      },
      {
        id: "open-group",
        label: "Group",
        icon: Users,
        perform: () => router.push(`${tripBase}/group`),
      },
      {
        id: "open-payments",
        label: "Payments",
        icon: CreditCard,
        perform: () => router.push(`${tripBase}/payments`),
      },
      {
        id: "open-summary",
        label: "Summary",
        icon: ScrollText,
        perform: () => router.push(`${tripBase}/summary`),
      },
    ];

    if (snapshot.itinerary?.status === "CURRENT" && snapshot.me.role === "OWNER") {
      cmds.unshift({
        id: "approve",
        label: "Approve & book",
        hint: "Triggers the full workflow",
        icon: Check,
        shortcut: "↵",
        perform: async () => {
          await onApprove();
        },
      });
    }

    if (q.trim()) {
      cmds.unshift({
        id: "send",
        label: `Tell the concierge: "${q.trim().slice(0, 60)}${q.length > 60 ? "…" : ""}"`,
        icon: Send,
        shortcut: "↵",
        perform: () => onSendMessage(q.trim()),
      });
    }

    if (!q) return cmds;
    const lower = q.toLowerCase();
    return cmds.filter(
      (c) => c.id === "send" || c.label.toLowerCase().includes(lower),
    );
  }, [q, snapshot.itinerary, snapshot.me.role, tripBase, router, onApprove, onSendMessage]);

  const handleSelect = (cmd: Command) => {
    cmd.perform();
    setOpen(false);
    setQ("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && commands[0]) {
                e.preventDefault();
                handleSelect(commands[0]);
              }
            }}
            placeholder="Type a command, or speak to your concierge…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
            ⌘K
          </kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {commands.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No matches.
            </p>
          ) : (
            commands.map((cmd, idx) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  onClick={() => handleSelect(cmd)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm hover:bg-surface-raised transition text-left"
                >
                  <Icon className="size-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate">{cmd.label}</span>
                  {cmd.hint && (
                    <span className="text-[10px] text-muted-foreground">
                      {cmd.hint}
                    </span>
                  )}
                  {idx === 0 && (
                    <kbd className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                      ↵
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
