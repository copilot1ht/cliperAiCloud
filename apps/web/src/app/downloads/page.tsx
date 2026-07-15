import { AppShell } from "@/components/app-shell";
import { Download } from "lucide-react";

export default function DownloadsPage() {
  return (
    <AppShell eyebrow="Downloads" title="Desktop resources">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Desktop downloads</p><h2>Install & desktop tools</h2><p>Unduh Cliper Studio installer dan asset helper untuk desktop.</p></div></div>
        <div className="download-grid"><article className="plan-card"><h2>Cliper Studio</h2><button className="button button-primary"><Download size={16} /> Download</button></article><article className="plan-card"><h2>CLI helper</h2><button className="button button-secondary">Download</button></article></div>
      </section>
    </AppShell>
  );
}
