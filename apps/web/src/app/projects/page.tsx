import { AppShell } from "@/components/app-shell";
import { Boxes } from "lucide-react";

export default function ProjectsPage() {
  return (
    <AppShell eyebrow="Projects" title="Project management">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Your projects</p><h2>Manage production workflows</h2><p>Tambah, atur, dan monitor project AI desktop dari satu panel.</p></div></div>
        <div className="project-grid"><article className="plan-card"><h2>Project A</h2><p>Video highlight, subtitle, dan caption.</p></article><article className="plan-card"><h2>Project B</h2><p>Script generation dan metadata AI.</p></article></div>
      </section>
    </AppShell>
  );
}
