import { AppShell } from "@/components/app-shell";
import { Save } from "lucide-react";

export default function AdminSettingsPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Settings" actions={<button className="button button-primary"><Save size={16} /> Save settings</button>}>
      <section className="panel form-panel"><div className="panel-head"><div><p className="section-kicker">Platform settings</p><h2>Global configuration</h2></div></div>
        <div className="form-grid"><label className="field-label">Admin email<input defaultValue="admin@cliper.cloud" /></label><label className="field-label">Support URL<input defaultValue="https://cliper.cloud/support" /></label><label className="field-label">Gateway URL<input defaultValue="https://api.cliper.cloud" /></label><label className="field-label">License server<input defaultValue="https://api.cliper.cloud/license" /></label></div>
      </section>
    </AppShell>
  );
}
