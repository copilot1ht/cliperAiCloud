import { AppShell } from "@/components/app-shell";
import { AdminReleaseCatalog } from "@/components/release-catalog";

export default function AdminReleasesPage() {
  return <AppShell eyebrow="Distribution" title="Desktop releases" role="admin"><AdminReleaseCatalog /></AppShell>;
}
