"use client";

import * as React from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

// Monochrome Clerk theme matching the pyltrix.com brand: white surfaces,
// hairline borders, ink-black primary. This is GLOBAL — it styles the
// sign-in/sign-up cards, user button menus, and every Clerk modal, so any
// theme change happens here, not per-page.
const clerkAppearance = {
  variables: {
    colorBackground: "#ffffff",
    colorInputBackground: "#ffffff",
    colorInputText: "#0a0a0a",
    colorText: "#0a0a0a",
    colorTextSecondary: "#525252",
    colorTextOnPrimaryBackground: "#ffffff",
    colorPrimary: "#0a0a0a",
    colorDanger: "#dc2626",
    colorNeutral: "#0a0a0a",
    borderRadius: "12px",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: "15px",
  },
  elements: {
    rootBox: "w-full",
    card: "bg-white border border-[#e6e6e6] shadow-[0_24px_80px_-24px_rgb(0_0_0/0.18)] rounded-2xl",
    headerTitle: "text-[#0a0a0a] text-2xl font-semibold tracking-tight",
    headerSubtitle: "text-[#525252] text-sm",
    socialButtonsBlockButton:
      "bg-white border border-[#e6e6e6] text-[#0a0a0a] hover:bg-[#fafafa] transition",
    socialButtonsBlockButtonText: "text-[#0a0a0a] font-medium",
    dividerLine: "bg-[#e6e6e6]",
    dividerText: "text-[#8a8a8a]",
    formFieldLabel: "text-[#0a0a0a] font-medium",
    formFieldInput:
      "bg-white border border-[#e6e6e6] text-[#0a0a0a] placeholder:text-[#8a8a8a] focus:border-[#0a0a0a] focus:ring-2 focus:ring-[#0a0a0a]/10 transition",
    formFieldInputShowPasswordButton: "text-[#8a8a8a] hover:text-[#0a0a0a]",
    formButtonPrimary:
      "bg-[#0a0a0a] text-white font-semibold hover:bg-[#0a0a0a]/90 transition shadow-sm",
    footer: "hidden",
    formFieldHintText: "text-[#8a8a8a]",
    identityPreviewText: "text-[#0a0a0a]",
    identityPreviewEditButton: "text-[#0a0a0a] underline underline-offset-4 hover:opacity-70",
    formResendCodeLink: "text-[#0a0a0a] underline underline-offset-4 hover:opacity-70",
    otpCodeFieldInput:
      "bg-white border border-[#e6e6e6] text-[#0a0a0a] focus:border-[#0a0a0a]",
  },
} as const;

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <ClerkProvider appearance={clerkAppearance}>
      <QueryClientProvider client={client}>
        {children}
        <Toaster
          theme="light"
          position="top-right"
          richColors
          toastOptions={{
            classNames: {
              toast:
                "!bg-card !border !border-border !text-foreground !rounded-2xl !shadow-2xl backdrop-blur-md",
            },
          }}
        />
      </QueryClientProvider>
    </ClerkProvider>
  );
}
