import { AppShell } from "@/components/app-shell";
import { MemberBilling } from "@/components/member-billing";

export default function BillingPage() {
  return (
    <AppShell eyebrow="Wallet" title="Wallet & top-up">
      <MemberBilling view="wallet" />
    </AppShell>
  );
}
