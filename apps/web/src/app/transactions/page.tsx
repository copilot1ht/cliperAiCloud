import { AppShell } from "@/components/app-shell";
import { MemberBilling } from "@/components/member-billing";

export default function TransactionsPage() {
  return (
    <AppShell eyebrow="Transactions" title="Transaction history">
      <MemberBilling view="transactions" />
    </AppShell>
  );
}
