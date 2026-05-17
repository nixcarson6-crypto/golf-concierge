"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  MoreHorizontal,
  Lock,
  Unlock,
  ArrowUpRight,
  ArrowDownRight,
  RotateCcw,
  Replace,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ItemAction =
  | { action: "swap"; instruction?: string }
  | { action: "upgrade" }
  | { action: "downgrade" }
  | { action: "regenerate" }
  | { action: "lock"; locked: boolean };

export function ItemActionsMenu({
  locked,
  onAction,
}: {
  locked: boolean;
  onAction: (a: ItemAction) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label="Item actions"
          className="size-7 rounded-lg grid place-items-center text-muted-foreground hover:text-foreground hover:bg-surface-raised transition opacity-60 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="min-w-[200px] rounded-xl border border-border bg-card p-1 shadow-2xl glass-strong z-50"
        >
          <Item onSelect={() => onAction({ action: "lock", locked: !locked })}>
            {locked ? <Unlock className="size-3.5" /> : <Lock className="size-3.5" />}
            {locked ? "Unlock this item" : "Lock this item"}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {locked ? "auto-edit" : "stays put"}
            </span>
          </Item>
          <Sep />
          <Item onSelect={() => onAction({ action: "swap" })}>
            <Replace className="size-3.5" />
            Swap for an alternative
          </Item>
          <Item onSelect={() => onAction({ action: "upgrade" })}>
            <ArrowUpRight className="size-3.5" />
            Upgrade
          </Item>
          <Item onSelect={() => onAction({ action: "downgrade" })}>
            <ArrowDownRight className="size-3.5" />
            Find a value option
          </Item>
          <Sep />
          <Item onSelect={() => onAction({ action: "regenerate" })}>
            <RotateCcw className="size-3.5" />
            Regenerate
          </Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({
  children,
  onSelect,
  destructive,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground cursor-pointer outline-none focus:bg-surface-raised data-[highlighted]:bg-surface-raised transition",
        destructive && "text-[hsl(var(--destructive))]",
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}

function Sep() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border/60" />;
}
