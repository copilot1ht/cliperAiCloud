import { AppShell } from "@/components/app-shell";
import { AdminRouter } from "@/components/admin-router";

export default function AdminAiRouterPage() {
  return <AppShell role="admin" eyebrow="Administration" title="AI Router"><AdminRouter /></AppShell>;
}
