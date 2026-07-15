import { AppShell } from "@/components/app-shell";
import { MemberBilling } from "@/components/member-billing";

export default function InvoicesPage() {
  return (
    <AppShell eyebrow="Invoices" title="Invoice history">
      <MemberBilling view="invoices" />
    </AppShell>
  );
}
