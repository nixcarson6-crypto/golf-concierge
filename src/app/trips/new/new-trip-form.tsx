"use client";

import { useTransition, useState } from "react";
import { Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NewTripForm({
  action,
  ownerName,
}: {
  action: (fd: FormData) => Promise<void>;
  ownerName: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");

  return (
    <form
      action={(fd) => startTransition(() => action(fd))}
      className="w-full max-w-md glass-strong rounded-3xl p-8"
    >
      <div className="flex items-center gap-2 text-[hsl(var(--gold))] text-sm">
        <Sparkles className="size-4" />
        <span>New trip</span>
      </div>
      <h1 className="mt-3 text-display text-3xl tracking-tight">
        {ownerName ? `Where to, ${ownerName}?` : "Where to?"}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Give your trip a quick name. You can describe everything else in the
        chat — your concierge will take it from there.
      </p>

      <div className="mt-7 space-y-2">
        <Label htmlFor="title">Trip name</Label>
        <Input
          id="title"
          name="title"
          autoFocus
          maxLength={120}
          placeholder="e.g. Scottsdale, October — 8 guys"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <Button
        type="submit"
        variant="gold"
        size="lg"
        className="mt-7 w-full"
        disabled={pending}
      >
        {pending ? "Starting…" : (
          <>
            Open the concierge <ArrowRight />
          </>
        )}
      </Button>
    </form>
  );
}
