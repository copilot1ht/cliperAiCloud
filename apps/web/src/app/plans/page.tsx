import { AppShell } from "@/components/app-shell";
import { MemberBilling } from "@/components/member-billing";

export default function PlansPage() {
  return (
    <AppShell eyebrow="Subscription" title="Plans & credits">
      <MemberBilling view="plans" />
    </AppShell>
  );
}
