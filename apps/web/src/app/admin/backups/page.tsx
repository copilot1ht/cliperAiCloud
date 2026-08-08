import { AppShell } from "@/components/app-shell";
import { AdminBackups } from "@/components/admin-backups";

export default function AdminBackupsPage() {
  return <AppShell role="admin" eyebrow="Operations" title="Backup & migration"><AdminBackups /></AppShell>;
}
