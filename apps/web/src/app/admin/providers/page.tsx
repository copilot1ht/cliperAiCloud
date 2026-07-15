import { AppShell } from "@/components/app-shell";
import { AdminProviders } from "@/components/admin-providers";

export default function AdminProvidersPage() {
  return <AppShell role="admin" eyebrow="Administration" title="Providers"><AdminProviders /></AppShell>;
}
