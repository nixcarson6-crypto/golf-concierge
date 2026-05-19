"use client";

import * as React from "react";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Quiet push-notification prompt. Shows a small "Enable notifications" pill
 * once when the user has the page open, lasts 30 seconds, dismissible. If
 * they accept, registers a service worker + subscription via the API.
 *
 * Stays silent if push isn't configured server-side, the browser doesn't
 * support push, or the user has already subscribed/declined.
 */
export function PushPrompt({ vapidKey }: { vapidKey: string | null }) {
  const [visible, setVisible] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!vapidKey) return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission === "denied") return;
    if (Notification.permission === "granted") {
      // Already granted — silently re-subscribe if missing.
      void ensureSubscription(vapidKey).catch(() => {});
      return;
    }
    if (typeof localStorage !== "undefined") {
      const dismissedAt = Number(localStorage.getItem("gc-push-dismissed") ?? 0);
      if (dismissedAt && Date.now() - dismissedAt < 1000 * 60 * 60 * 24 * 14) {
        return;
      }
    }
    const t = setTimeout(() => setVisible(true), 4_000);
    return () => clearTimeout(t);
  }, [vapidKey]);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem("gc-push-dismissed", String(Date.now()));
    } catch {}
  };

  const enable = async () => {
    if (!vapidKey) return;
    setBusy(true);
    try {
      await ensureSubscription(vapidKey);
      toast.success("Notifications on — you'll get pinged on key updates.");
      setVisible(false);
    } catch (err) {
      toast.error("Couldn't turn on notifications.");
      console.error("[push prompt]", err);
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 max-w-sm glass-strong rounded-2xl p-4 shadow-2xl border border-[hsl(var(--navy)/0.3)] animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-xl bg-[hsl(var(--navy)/0.12)] grid place-items-center text-[hsl(var(--navy))]">
          <Bell className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Get notified instantly</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Bookings, payments, and re-optimizations — pinged the moment they happen.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <Button variant="navy" size="sm" onClick={enable} disabled={busy}>
              <Bell className="size-3.5" /> {busy ? "Turning on…" : "Enable"}
            </Button>
            <Button variant="ghost" size="sm" onClick={dismiss}>
              <BellOff className="size-3.5" /> Not now
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

async function ensureSubscription(vapidKey: string) {
  const reg = await navigator.serviceWorker.register("/sw.js");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
  }
  const json = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: navigator.userAgent,
    }),
  });
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
