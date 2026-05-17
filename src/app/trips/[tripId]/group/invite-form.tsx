"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function InviteForm({ tripId }: { tripId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!email.trim()) return;
        start(async () => {
          const res = await fetch(`/api/trips/${tripId}/invites`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email.trim() }),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            toast.error(`Could not send invite${txt ? `: ${txt}` : ""}`);
            return;
          }
          toast.success("Invite sent.");
          setEmail("");
          router.refresh();
        });
      }}
      className="space-y-3"
    >
      <div className="space-y-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input
          id="invite-email"
          type="email"
          required
          placeholder="member@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <Button type="submit" variant="navy" size="md" disabled={pending} className="w-full">
        <Send className="size-4" /> {pending ? "Sending…" : "Send invite"}
      </Button>
    </form>
  );
}
