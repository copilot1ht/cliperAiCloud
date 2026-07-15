import { AppShell } from "@/components/app-shell";
import { Settings2 } from "lucide-react";

export default function AdminSettingsPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Settings">
      <section className="panel form-panel"><div className="panel-head"><div><p className="section-kicker">Runtime configuration</p><h2>Environment-managed settings</h2><p>Nilai production dikelola melalui environment API atau secret manager, bukan form browser.</p></div><Settings2 size={19} /></div>
        <div className="readiness-list"><span><i className="ready" /><strong>Admin access</strong><small>Controlled by server bootstrap credentials</small></span><span><i className="ready" /><strong>Gateway origin</strong><small>Configured by API environment</small></span><span><i className="ready" /><strong>Payment provider</strong><small>Configured server-side; secret keys never enter the browser</small></span><span><i className="ready" /><strong>Database and Redis</strong><small>Enable before production release</small></span></div>
      </section>
    </AppShell>
  );
}
