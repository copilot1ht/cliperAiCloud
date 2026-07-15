import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cliper AI Cloud",
  description: "AI gateway, licenses, usage, and billing for Cliper Studio Plus.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
