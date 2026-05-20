"use client";

import * as React from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

const clerkAppearance = {
  variables: {
    colorBackground: "#0a0a0c",
    colorInputBackground: "#16161e",
    colorInputText: "#f5f0e3",
    colorText: "#f5f0e3",
    colorTextSecondary: "#d4cfc1",
    colorTextOnPrimaryBackground: "#0a0a0c",
    colorPrimary: "#d6b274",
    colorDanger: "#ff6f6f",
    colorNeutral: "#f5f0e3",
    borderRadius: "14px",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: "15px",
  },
  elements: {
    rootBox: "w-full",
    card: "bg-[#0f0f15] border border-[#2a2a35] shadow-2xl",
    headerTitle: "text-[#f5f0e3] text-2xl font-semibold tracking-tight",
    headerSubtitle: "text-[#c9c4b5] text-sm",
    socialButtonsBlockButton:
      "bg-[#16161e] border border-[#2a2a35] text-[#f5f0e3] hover:bg-[#1d1d28]",
    socialButtonsBlockButtonText: "text-[#f5f0e3] font-medium",
    dividerLine: "bg-[#2a2a35]",
    dividerText: "text-[#a8a292]",
    formFieldLabel: "text-[#e8e3d4] font-medium",
    formFieldInput:
      "bg-[#16161e] border border-[#2a2a35] text-[#f5f0e3] placeholder:text-[#7a7568]",
    formFieldInputShowPasswordButton: "text-[#a8a292] hover:text-[#f5f0e3]",
    formButtonPrimary:
      "bg-[#d6b274] text-[#0a0a0c] font-semibold hover:bg-[#e0bf85] shadow-lg shadow-[#d6b274]/20",
    footer: "hidden",
    formFieldHintText: "text-[#a8a292]",
    identityPreviewText: "text-[#f5f0e3]",
    identityPreviewEditButton: "text-[#d6b274] hover:text-[#e0bf85]",
    formResendCodeLink: "text-[#d6b274] hover:text-[#e0bf85]",
    otpCodeFieldInput:
      "bg-[#16161e] border border-[#2a2a35] text-[#f5f0e3]",
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
          theme="dark"
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
