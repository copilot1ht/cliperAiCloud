import { AppShell } from "@/components/app-shell";
import { AdminSystemHealth } from "@/components/admin-system-health";

export default function AdminSystemHealthPage() {
  return <AppShell role="admin" eyebrow="Operations" title="System Health"><AdminSystemHealth /></AppShell>;
}
