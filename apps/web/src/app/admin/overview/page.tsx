import Link from "next/link";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AdminOverview } from "@/components/admin-overview";

export default function AdminOverviewPage() {
  return <AppShell role="admin" eyebrow="Administration" title="Cloud control plane" actions={<Link className="button button-primary" href="/admin/providers"><Plus size={16} /> Add provider</Link>}><AdminOverview /></AppShell>;
}
