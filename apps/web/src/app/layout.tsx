import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Cliper AI Cloud",
  title: {
    default: "Cliper AI Cloud",
    template: "%s | Cliper AI Cloud",
  },
  description: "AI gateway, licenses, usage, and billing for Cliper Studio Plus.",
  category: "technology",
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/favicon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#009b94",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
