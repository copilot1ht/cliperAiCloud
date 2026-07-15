import { AppShell } from "@/components/app-shell";
import { AdminPayments } from "@/components/admin-payments";

export default function AdminPaymentsPage() {
  return <AppShell role="admin" eyebrow="Administration" title="Payments"><AdminPayments /></AppShell>;
}
