"use client";

import * as React from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkspaceMe } from "./workspace";

/**
 * Standalone traveler profile collection modal. Collects the
 * airline-required fields (legal name, DOB, gender, email, phone) and
 * saves them to /api/me/profile so future flight bookings are one-tap.
 *
 * Distinct from FlightBookingModal — that one is tied to a specific
 * Duffel offer and books on submit. This one has no offer, doesn't
 * book, just persists the profile. Opened from the "Add traveler info"
 * banner on the result page so the customer can prep BEFORE they hit
 * Book All, instead of getting a "fill in your profile first" toast
 * with nowhere to go.
 */
export function TravelerProfileModal({
  open,
  onOpenChange,
  profile,
  defaultEmail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: WorkspaceMe["profile"];
  defaultEmail: string;
  onSaved?: () => void;
}) {
  // Phones saved to the profile might be in pretty-formatted form
  // ("+1 (212) 555-0100") or even sans plus sign ("2125550100"). The
  // booking validator demands strict E.164 (^\+\d{8,15}$), so normalise
  // on the way IN so the pre-filled form is valid out of the box.
  const normalizePhone = (raw: string | null | undefined): string => {
    if (!raw) return "";
    const digits = raw.replace(/[^\d]/g, "");
    if (digits.length === 0) return "";
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return `+${digits}`;
  };

  type Form = {
    given_name: string;
    family_name: string;
    born_on: string;
    gender: "" | "m" | "f";
    email: string;
    phone_number: string;
  };

  const initial = React.useMemo<Form>(
    () => ({
      given_name: profile.legalGivenName ?? "",
      family_name: profile.legalFamilyName ?? "",
      born_on: profile.dateOfBirth ?? "",
      gender:
        profile.gender === "m" || profile.gender === "f" ? profile.gender : "",
      email: defaultEmail ?? "",
      phone_number: normalizePhone(profile.phone),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const [form, setForm] = React.useState<Form>(initial);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  const update = <K extends keyof Form>(field: K, value: Form[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  // Form is valid for saving when EVERY field is filled correctly.
  // Email defaults from Clerk so it's always set; the others are user-
  // entered. We still let partial saves through (best-effort per field)
  // but the primary CTA gates on full validity so customers know
  // they're done.
  const allValid =
    form.given_name.trim().length > 0 &&
    form.family_name.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.born_on) &&
    (form.gender === "m" || form.gender === "f") &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) &&
    /^\+\d{8,15}$/.test(form.phone_number);

  const save = async () => {
    if (saving) return;
    // Send only valid fields — the endpoint rejects bad shapes per-
    // field, but we don't want one bad field to drop a good one.
    const payload: Record<string, string> = {};
    if (form.given_name.trim()) payload.legalGivenName = form.given_name.trim();
    if (form.family_name.trim())
      payload.legalFamilyName = form.family_name.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(form.born_on))
      payload.dateOfBirth = form.born_on;
    if (form.gender === "m" || form.gender === "f") payload.gender = form.gender;
    if (/^\+\d{8,15}$/.test(form.phone_number))
      payload.phone = form.phone_number;

    if (Object.keys(payload).length === 0) {
      toast.error("Fill in at least one field before saving.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        toast.success("Traveler info saved.");
        onSaved?.();
        onOpenChange(false);
      } else {
        toast.error("Couldn't save your info. Try again.");
      }
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden">
        <header className="px-6 py-4 border-b border-border/50 bg-[hsl(var(--copper))]/8">
          <DialogHeader>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none mb-1">
              Traveler info
            </p>
            <DialogTitle className="text-base font-semibold leading-tight">
              Save your details for one-tap booking
            </DialogTitle>
          </DialogHeader>
        </header>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Airlines require your full legal name, date of birth, gender, and
            contact details on every ticket (TSA Secure Flight rule). We save
            this once so you never have to re-enter it. We don&apos;t book or
            charge anything from this screen.
          </p>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Lead traveller (you)
              </p>
              {profile.legalGivenName && profile.dateOfBirth && (
                <span className="text-[10px] text-[hsl(var(--emerald))] inline-flex items-center gap-1">
                  <ShieldCheck className="size-3" />
                  Already on file
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Legal first name"
                value={form.given_name}
                onChange={(v) => update("given_name", v)}
                placeholder="As shown on passport / ID"
              />
              <Field
                label="Legal last name"
                value={form.family_name}
                onChange={(v) => update("family_name", v)}
                placeholder="As shown on passport / ID"
              />
              <Field
                label="Date of birth"
                type="date"
                value={form.born_on}
                onChange={(v) => update("born_on", v)}
              />
              <div>
                <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  Gender (per ID)
                </label>
                <div className="mt-1 flex gap-2">
                  {(["m", "f"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => update("gender", g)}
                      className={cn(
                        "flex-1 rounded-xl border px-3 py-2 text-sm transition",
                        form.gender === g
                          ? "border-[hsl(var(--copper))] bg-[hsl(var(--copper))]/10 text-[hsl(var(--copper))]"
                          : "border-border bg-surface-raised hover:border-foreground/30",
                      )}
                    >
                      {g === "m" ? "Male" : "Female"}
                    </button>
                  ))}
                </div>
              </div>
              <Field
                label="Email"
                type="email"
                value={form.email}
                onChange={(v) => update("email", v)}
                placeholder="confirmations sent here"
              />
              <Field
                label="Phone (with country code)"
                value={form.phone_number}
                onChange={(v) => update("phone_number", v)}
                placeholder="+12125550100"
              />
            </div>
          </section>

          <section className="flex items-center justify-between gap-2 pt-3 border-t border-border/40">
            <p className="text-[10px] text-muted-foreground">
              {allValid
                ? "All set — saving will enable one-tap flight booking."
                : "Fill in every field to enable one-tap booking later."}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={save}
                disabled={saving}
                className="bg-[hsl(var(--copper))] text-white hover:bg-[hsl(var(--copper))]/90"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-3 mr-1.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm"
      />
    </label>
  );
}
