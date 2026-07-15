import { AppShell } from "@/components/app-shell";
import { Save } from "lucide-react";

export default function SettingsPage() {
  return <AppShell eyebrow="Workspace" title="Settings" actions={<button className="button button-primary"><Save size={16} /> Save changes</button>}><section className="panel form-panel"><div className="panel-head"><div><p className="section-kicker">Organization</p><h2>Workspace profile</h2></div></div><div className="form-grid"><label className="field-label">Workspace name<input defaultValue="Cliper Studio" /></label><label className="field-label">Billing email<input type="email" defaultValue="admin@cliper.cloud" /></label><label className="field-label">Timezone<select defaultValue="Asia/Jakarta"><option>Asia/Jakarta</option><option>UTC</option></select></label><label className="field-label">Default currency<select defaultValue="USD"><option>USD</option><option>IDR</option></select></label></div></section></AppShell>;
}
