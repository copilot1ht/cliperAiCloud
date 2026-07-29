import { AppShell } from "@/components/app-shell";
import { MemberBilling } from "@/components/member-billing";

export default function TopUpPage() {
  return (
    <AppShell eyebrow="Top up" title="Add Cliper Credits">
      <MemberBilling view="wallet" autoOpenTopup />
    </AppShell>
  );
}
