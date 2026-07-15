import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AdminUsers } from "@/components/admin-users";

export default function AdminUsersPage() {
  return <AppShell role="admin" eyebrow="Administration" title="Users & plans"><AdminUsers /></AppShell>;
}
