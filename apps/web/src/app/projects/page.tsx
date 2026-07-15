import { AppShell } from "@/components/app-shell";
import { FolderOpen } from "lucide-react";

export default function ProjectsPage() {
  return (
    <AppShell eyebrow="Projects" title="Project management">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Your projects</p><h2>Manage production workflows</h2><p>Project workspace akan terisi setelah Cliper Studio mengirim project pertama.</p></div></div>
        <div className="admin-empty"><FolderOpen size={22} /><strong>Belum ada project cloud</strong><span>Gunakan Cliper Studio untuk membuat workflow highlight, subtitle, dan metadata pertama.</span></div>
      </section>
    </AppShell>
  );
}
