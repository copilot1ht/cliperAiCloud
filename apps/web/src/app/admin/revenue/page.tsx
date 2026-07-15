import { AppShell } from "@/components/app-shell";
import { AdminRevenue } from "@/components/admin-revenue";

export default function AdminRevenuePage() {
  return <AppShell role="admin" eyebrow="Administration" title="Revenue"><AdminRevenue /></AppShell>;
}
