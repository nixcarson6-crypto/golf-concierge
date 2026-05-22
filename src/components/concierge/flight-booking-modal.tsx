"use client";

import * as React from "react";
import { Plane, ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SuggestedFlightOffer, WorkspaceMe } from "./workspace";

/**
 * One-click flight booking modal. Replaces the previous "send a message
 * to chat and let the AI book" detour. Collects the airline-required
 * passenger fields (legal name, DOB, gender, email, phone) in a clean
 * form, pre-fills from the user's saved profile so repeat bookings are
 * a single submit, then calls /api/trips/[id]/book-flight to ticket
 * via Duffel. On success, the lead passenger's details get saved back
 * to the User profile for next time.
 */
export function FlightBookingModal({
  open,
  onOpenChange,
  tripId,
  offer,
  passengerCount,
  cabin,
  profile,
  defaultEmail,
  onBooked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tripId: string;
  offer: SuggestedFlightOffer;
  passengerCount: number;
  cabin: string;
  profile: WorkspaceMe["profile"];
  defaultEmail: string;
  onBooked: (result: {
    bookingReference: string;
    airline: string;
    totalUSD: number;
  }) => void;
}) {
  type PassengerForm = {
    given_name: string;
    family_name: string;
    born_on: string;
    gender: "" | "m" | "f";
    email: string;
    phone_number: string;
  };

  const blank = (): PassengerForm => ({
    given_name: "",
    family_name: "",
    born_on: "",
    gender: "",
    email: "",
    phone_number: "",
  });

  // Initialise passengers with the user's saved profile for the lead
  // slot, blanks for the rest. Stored as state so edits persist while
  // the user is typing.
  // Phones saved to the profile might be in pretty-formatted form
  // ("+1 (212) 555-0100") or even sans plus sign ("2125550100"). The
  // booking validator demands strict E.164 (^\+\d{8,15}$), so normalize
  // on the way IN so the pre-filled form is valid out of the box.
  const normalizePhone = (raw: string | null | undefined): string => {
    if (!raw) return "";
    const digits = raw.replace(/[^\d]/g, "");
    if (digits.length === 0) return "";
    // US default: 10 digits → +1XXXXXXXXXX. 11 digits starting with 1
    // → keep as is. Otherwise just stick a + in front of the digits.
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return `+${digits}`;
  };

  const initialPassengers = React.useMemo<PassengerForm[]>(() => {
    const list: PassengerForm[] = [];
    for (let i = 0; i < passengerCount; i++) {
      if (i === 0) {
        list.push({
          given_name: profile.legalGivenName ?? "",
          family_name: profile.legalFamilyName ?? "",
          born_on: profile.dateOfBirth ?? "",
          gender:
            profile.gender === "m" || profile.gender === "f"
              ? profile.gender
              : "",
          email: defaultEmail ?? "",
          phone_number: normalizePhone(profile.phone),
        });
      } else {
        list.push(blank());
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passengerCount, open]);

  const [passengers, setPassengers] =
    React.useState<PassengerForm[]>(initialPassengers);
  const [submitting, setSubmitting] = React.useState(false);
  const [savingProfile, setSavingProfile] = React.useState(false);

  React.useEffect(() => {
    // Reset when reopened so a stale half-filled state doesn't bleed
    // across separate booking attempts.
    if (open) setPassengers(initialPassengers);
  }, [open, initialPassengers]);

  const updateField = <K extends keyof PassengerForm>(
    idx: number,
    field: K,
    value: PassengerForm[K],
  ) => {
    setPassengers((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const allValid = passengers.every(
    (p) =>
      p.given_name.trim().length > 0 &&
      p.family_name.trim().length > 0 &&
      /^\d{4}-\d{2}-\d{2}$/.test(p.born_on) &&
      (p.gender === "m" || p.gender === "f") &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) &&
      /^\+\d{8,15}$/.test(p.phone_number),
  );

  const submit = async () => {
    if (!allValid || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/book-flight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offerId: offer.id,
          passengers: passengers.map((p) => ({
            given_name: p.given_name.trim(),
            family_name: p.family_name.trim(),
            born_on: p.born_on,
            gender: p.gender as "m" | "f",
            email: p.email.trim(),
            phone_number: p.phone_number.trim(),
          })),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        bookingReference?: string;
        airline?: string;
        totalUSD?: number;
      } | null;
      if (!res.ok || !data?.ok || !data.bookingReference) {
        toast.error(data?.error ?? "Booking failed. Try again.");
        return;
      }
      toast.success(
        `Booked ${data.airline} — confirmation ${data.bookingReference}`,
      );
      onBooked({
        bookingReference: data.bookingReference,
        airline: data.airline ?? offer.airlineName,
        totalUSD: data.totalUSD ?? Math.round(offer.totalAmount / 100),
      });
      onOpenChange(false);
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * "Save & close" path: persists whatever the user has typed into
   * their User profile (best-effort per-field) WITHOUT booking. Lets
   * people back out of the auto-book modal without losing what they
   * just typed — next time they come to book, it's pre-filled.
   */
  const saveProfileAndClose = async () => {
    if (savingProfile) return;
    const lead = passengers[0];
    if (!lead) {
      onOpenChange(false);
      return;
    }
    // Build the payload from whatever fields the user has filled in.
    // Send only valid values — the endpoint rejects bad shapes
    // per-field, but we don't want one bad field to drop a good one.
    const payload: Record<string, string> = {};
    if (lead.given_name.trim()) payload.legalGivenName = lead.given_name.trim();
    if (lead.family_name.trim())
      payload.legalFamilyName = lead.family_name.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(lead.born_on))
      payload.dateOfBirth = lead.born_on;
    if (lead.gender === "m" || lead.gender === "f")
      payload.gender = lead.gender;
    if (/^\+\d{8,15}$/.test(lead.phone_number))
      payload.phone = lead.phone_number;

    if (Object.keys(payload).length === 0) {
      onOpenChange(false);
      return;
    }
    setSavingProfile(true);
    try {
      const res = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        toast.success("Saved your traveler info — book any time.");
      } else {
        toast.error("Couldn't save your info. Try again.");
      }
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSavingProfile(false);
      onOpenChange(false);
    }
  };

  const total = Math.round(offer.totalAmount / 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 overflow-hidden">
        <header className="px-6 py-4 border-b border-border/50 bg-[hsl(var(--copper))]/8">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="size-9 rounded-xl bg-surface-raised grid place-items-center text-foreground shrink-0">
                <Plane className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none mb-1">
                  Book {offer.airlineName} · {cabin.replace("_", " ")}
                </p>
                <DialogTitle className="text-base font-semibold leading-tight truncate">
                  ${total.toLocaleString()} total · {passengerCount}{" "}
                  {passengerCount === 1 ? "traveller" : "travellers"}
                </DialogTitle>
              </div>
            </div>
          </div>
        </header>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Airlines require full legal name, date of birth, gender, and
            contact details on every ticket (TSA Secure Flight rule). We
            save your info after the first booking so the next one is one
            click.
          </p>

          {passengers.map((p, idx) => (
            <section key={idx} className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  {idx === 0 ? "Lead traveller" : `Traveller ${idx + 1}`}
                </p>
                {idx === 0 &&
                  profile.legalGivenName &&
                  profile.dateOfBirth && (
                    <span className="text-[10px] text-[hsl(var(--emerald))] inline-flex items-center gap-1">
                      <ShieldCheck className="size-3" />
                      Pre-filled from your profile
                    </span>
                  )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Legal first name"
                  value={p.given_name}
                  onChange={(v) => updateField(idx, "given_name", v)}
                  placeholder="As shown on passport / ID"
                />
                <Field
                  label="Legal last name"
                  value={p.family_name}
                  onChange={(v) => updateField(idx, "family_name", v)}
                  placeholder="As shown on passport / ID"
                />
                <Field
                  label="Date of birth"
                  type="date"
                  value={p.born_on}
                  onChange={(v) => updateField(idx, "born_on", v)}
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
                        onClick={() => updateField(idx, "gender", g)}
                        className={cn(
                          "flex-1 rounded-xl border px-3 py-2 text-sm transition",
                          p.gender === g
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
                  value={p.email}
                  onChange={(v) => updateField(idx, "email", v)}
                  placeholder="confirmations sent here"
                />
                <Field
                  label="Phone (with country code)"
                  value={p.phone_number}
                  onChange={(v) => updateField(idx, "phone_number", v)}
                  placeholder="+12125550100"
                />
              </div>
            </section>
          ))}

          <section className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-border/40">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting || savingProfile}
              className="shrink-0"
            >
              Cancel
            </Button>
            {/* Save & close: persist the form to the user profile without
                booking. Booking happens later via the suggested-flight
                card → itinerary dialog → real ticketing flow. This modal
                is now a pure "save my traveler info" surface. */}
            <Button
              size="sm"
              onClick={saveProfileAndClose}
              disabled={submitting || savingProfile}
              className="shrink-0 bg-[hsl(var(--copper))] text-white hover:bg-[hsl(var(--copper))]/90"
            >
              {savingProfile ? (
                <>
                  <Loader2 className="size-3 mr-1.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Done"
              )}
            </Button>
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
