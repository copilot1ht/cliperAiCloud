import { AppShell } from "@/components/app-shell";
import { routingRules } from "@/lib/demo-data";
import { ArrowRight, CircleDollarSign, Save, ShieldCheck, Sparkles } from "lucide-react";

export default function RoutingPage() {
  return (
    <AppShell eyebrow="AI orchestration" title="Routing policy" actions={<button className="button button-primary"><Save size={16} /> Save policy</button>}>
      <div className="notice-line"><div><Sparkles size={17} /><span><strong>Module-aware routing.</strong> Set quality where editorial judgment matters and economy for repetitive cleanup.</span></div><span className="security-badge"><ShieldCheck size={15} /> Automatic fallback</span></div>
      <section className="panel table-panel"><div className="panel-head"><div><p className="section-kicker">Production rules</p><h2>Module routing</h2><p>Rules are evaluated per request. Disabled or unhealthy providers are skipped.</p></div></div><div className="routing-list">{routingRules.map((rule) => <div className="routing-row" key={rule.module}><span><strong>{rule.module}</strong><small>{rule.mode} mode · {rule.budget} max tokens</small></span><div className="route-flow"><b>{rule.primary}</b><ArrowRight size={16} /><b>{rule.fallback}</b></div><span><small>Timeout</small><strong>{rule.timeout}</strong></span><button className="button button-secondary button-small">Edit</button></div>)}</div></section>
      <div className="two-column"><section className="panel"><div className="panel-head"><div><p className="section-kicker">Cost guard</p><h2>Budget protection</h2></div><CircleDollarSign size={20} className="muted-icon" /></div><label className="setting-row"><span><strong>Prefer lower cost after quota</strong><small>Switch eligible modules to economy routing at 80% usage.</small></span><input type="checkbox" defaultChecked /></label><label className="setting-row"><span><strong>Reject unexpected models</strong><small>Prevent desktop clients from bypassing module policy.</small></span><input type="checkbox" defaultChecked /></label></section><section className="panel"><div className="panel-head"><div><p className="section-kicker">Resilience</p><h2>Failure policy</h2></div></div><label className="field-label">Retries per provider<select defaultValue="2"><option>1</option><option>2</option><option>3</option></select></label><label className="field-label">Circuit breaker threshold<select defaultValue="3 failures"><option>3 failures</option><option>5 failures</option><option>10 failures</option></select></label></section></div>
    </AppShell>
  );
}
