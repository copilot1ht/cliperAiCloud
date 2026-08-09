import { AppShell } from "@/components/app-shell";
import { AdminPaymentSettings } from "@/components/admin-payment-settings";

export default function AdminSettingsPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Settings">
      <AdminPaymentSettings />
    </AppShell>
  );
}
