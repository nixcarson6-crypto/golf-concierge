"use client";

import * as React from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

const clerkAppearance = {
  variables: {
    colorBackground: "#0a0a0c",
    colorInputBackground: "#13131a",
    colorInputText: "#f1ece1",
    colorText: "#f1ece1",
    colorTextSecondary: "#a8a292",
    colorPrimary: "#d6b274",
    colorDanger: "#c84a4a",
    borderRadius: "14px",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  elements: {
    card: "bg-card border border-border",
    formButtonPrimary: "bg-primary text-primary-foreground hover:brightness-110",
    footer: "hidden",
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
