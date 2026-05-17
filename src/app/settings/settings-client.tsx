"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/utils";

type Subscription = {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
};

export function SettingsClient({
  vapidKey,
  subscriptions,
}: {
  vapidKey: string | null;
  subscriptions: Subscription[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const enable = async () => {
    if (!vapidKey) {
      toast.error("Push isn't configured on the server.");
      return;
    }
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          toast.error("Notifications blocked by the browser.");
          return;
        }
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
      toast.success("Push enabled on this device.");
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error("Could not enable push.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (sub: Subscription) => {
    setBusy(true);
    try {
      // Try to remove the local subscription too if it's this device.
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const localSub = await reg?.pushManager.getSubscription();
        if (localSub?.endpoint === sub.endpoint) {
          await localSub.unsubscribe();
        }
      } catch {}
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      toast.success("Device removed.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Push notifications</h2>
        <Button
          variant="navy"
          size="sm"
          onClick={enable}
          disabled={busy || !vapidKey}
        >
          <Bell className="size-3.5" /> {busy ? "…" : "Enable on this device"}
        </Button>
      </div>
      {!vapidKey && (
        <p className="mt-2 text-xs text-muted-foreground">
          Push isn't configured on the server yet. Once VAPID keys are set,
          you'll be able to opt in here.
        </p>
      )}
      {subscriptions.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No devices subscribed.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border/60">
          {subscriptions.map((s) => (
            <li key={s.id} className="py-3 flex items-center gap-3">
              <BellOff className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-xs truncate">
                  {prettyAgent(s.userAgent ?? "Unknown device")}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Added {relativeTime(s.createdAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => disable(s)}
                disabled={busy}
              >
                <Trash2 className="size-4" />
                <span className="sr-only">Remove</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function prettyAgent(ua: string) {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return ua.split(" ")[0] ?? ua;
}
