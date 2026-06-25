"use client";

/**
 * Traveler details — the saved booking profile the AI reuses to auto-fill
 * flights / hotels / tee times so the customer doesn't retype it every trip.
 * Backs the same fields the flight modal collects, surfaced here so a repeat
 * customer can review + edit them up front. Saves via PATCH /api/me/profile,
 * which only updates the fields we send (empty fields are left untouched).
 */

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type TravelerProfile = {
  legalGivenName: string | null;
  legalFamilyName: string | null;
  dateOfBirth: string | null; // YYYY-MM-DD
  gender: string | null; // "m" | "f"
  phone: string | null;
  addressLine1: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressPostalCode: string | null;
  addressCountry: string | null;
  defaultOriginAirport: string | null;
};

const inputCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/40 transition";

export function TravelerSection({ profile }: { profile: TravelerProfile }) {
  const [form, setForm] = React.useState(() => normalize(profile));
  const [saving, setSaving] = React.useState(false);

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (saving) return;

    // Build a payload of only the filled fields, validating the formatted ones.
    const payload: Record<string, string> = {};
    const add = (k: string, v: string) => {
      if (v.trim()) payload[k] = v.trim();
    };

    add("legalGivenName", form.legalGivenName);
    add("legalFamilyName", form.legalFamilyName);
    if (form.dateOfBirth) payload.dateOfBirth = form.dateOfBirth;
    if (form.gender === "m" || form.gender === "f") payload.gender = form.gender;

    if (form.phone.trim()) {
      if (!/^\+\d{8,15}$/.test(form.phone.trim())) {
        toast.error("Phone must include your country code, e.g. +12125550100.");
        return;
      }
      payload.phone = form.phone.trim();
    }

    add("addressLine1", form.addressLine1);
    add("addressCity", form.addressCity);
    add("addressState", form.addressState);
    add("addressPostalCode", form.addressPostalCode);

    if (form.addressCountry.trim()) {
      if (!/^[A-Za-z]{2}$/.test(form.addressCountry.trim())) {
        toast.error("Country must be a 2-letter code, e.g. US.");
        return;
      }
      payload.addressCountry = form.addressCountry.trim().toUpperCase();
    }

    if (form.defaultOriginAirport.trim()) {
      if (!/^[A-Za-z]{3}$/.test(form.defaultOriginAirport.trim())) {
        toast.error("Home airport must be a 3-letter code, e.g. DFW.");
        return;
      }
      payload.defaultOriginAirport = form.defaultOriginAirport
        .trim()
        .toUpperCase();
    }

    if (Object.keys(payload).length === 0) {
      toast.error("Fill in a field before saving.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(
          data?.error ? `Couldn't save: ${data.error}` : "Couldn't save — try again.",
        );
        return;
      }
      toast.success("Traveler details saved.");
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="glass rounded-2xl p-6">
      <h2 className="text-sm font-medium">Traveler details</h2>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
        Used to auto-fill your bookings — flights, hotels, and tee times — so you
        don&apos;t retype them each trip. Your legal name must match your ID.
      </p>

      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Legal first name">
          <input
            className={inputCls}
            value={form.legalGivenName}
            onChange={set("legalGivenName")}
            placeholder="As shown on your ID"
            autoComplete="given-name"
          />
        </Field>
        <Field label="Legal last name">
          <input
            className={inputCls}
            value={form.legalFamilyName}
            onChange={set("legalFamilyName")}
            autoComplete="family-name"
          />
        </Field>
        <Field label="Date of birth">
          <input
            type="date"
            className={inputCls}
            value={form.dateOfBirth}
            onChange={set("dateOfBirth")}
            autoComplete="bday"
          />
        </Field>
        <Field label="Gender (for airline tickets)">
          <select
            className={inputCls}
            value={form.gender}
            onChange={set("gender")}
          >
            <option value="">—</option>
            <option value="m">Male</option>
            <option value="f">Female</option>
          </select>
        </Field>
        <Field label="Phone">
          <input
            className={inputCls}
            value={form.phone}
            onChange={set("phone")}
            placeholder="+12125550100"
            inputMode="tel"
            autoComplete="tel"
          />
        </Field>
        <Field label="Home airport">
          <input
            className={inputCls}
            value={form.defaultOriginAirport}
            onChange={set("defaultOriginAirport")}
            placeholder="DFW"
            maxLength={3}
          />
        </Field>
      </div>

      <h3 className="mt-6 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
        Billing address
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Some hotels require it at checkout.
      </p>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <Field label="Street address">
            <input
              className={inputCls}
              value={form.addressLine1}
              onChange={set("addressLine1")}
              autoComplete="address-line1"
            />
          </Field>
        </div>
        <Field label="City">
          <input
            className={inputCls}
            value={form.addressCity}
            onChange={set("addressCity")}
            autoComplete="address-level2"
          />
        </Field>
        <Field label="State / region">
          <input
            className={inputCls}
            value={form.addressState}
            onChange={set("addressState")}
            autoComplete="address-level1"
          />
        </Field>
        <Field label="Postal code">
          <input
            className={inputCls}
            value={form.addressPostalCode}
            onChange={set("addressPostalCode")}
            autoComplete="postal-code"
          />
        </Field>
        <Field label="Country">
          <input
            className={inputCls}
            value={form.addressCountry}
            onChange={set("addressCountry")}
            placeholder="US"
            maxLength={2}
            autoComplete="country"
          />
        </Field>
      </div>

      <div className="mt-6">
        <Button variant="navy" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Save details
        </Button>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function normalize(p: TravelerProfile) {
  return {
    legalGivenName: p.legalGivenName ?? "",
    legalFamilyName: p.legalFamilyName ?? "",
    dateOfBirth: p.dateOfBirth ?? "",
    gender: p.gender ?? "",
    phone: p.phone ?? "",
    addressLine1: p.addressLine1 ?? "",
    addressCity: p.addressCity ?? "",
    addressState: p.addressState ?? "",
    addressPostalCode: p.addressPostalCode ?? "",
    addressCountry: p.addressCountry ?? "",
    defaultOriginAirport: p.defaultOriginAirport ?? "",
  };
}
