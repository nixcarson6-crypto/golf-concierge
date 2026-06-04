import type { Metadata, Viewport } from "next";
import { Inter, Fraunces } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: {
    default: "Pyltrix — luxury golf trips, planned and booked by AI",
    template: "%s · Pyltrix",
  },
  description:
    "Answer a few questions. Pyltrix's AI builds a complete bookable golf trip — flights, lodging, tee times, dining, transport — and books it end-to-end.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    title: "Pyltrix",
    description:
      "AI-native luxury golf travel. Complete trips planned and booked end-to-end.",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} dark`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
