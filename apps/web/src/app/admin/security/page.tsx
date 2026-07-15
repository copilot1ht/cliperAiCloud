import { AppShell } from "@/components/app-shell";
import { AdminSecurity } from "@/components/admin-security";

export default function AdminSecurityPage() {
  return <AppShell role="admin" eyebrow="Security" title="Sessions & audit"><AdminSecurity /></AppShell>;
}
