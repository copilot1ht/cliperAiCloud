import { AppShell } from "@/components/app-shell";
import { MemberBilling } from "@/components/member-billing";

export default function BillingPage() {
  return (
    <AppShell eyebrow="Billing" title="Subscription plans">
      <MemberBilling view="plans" />
    </AppShell>
  );
}
