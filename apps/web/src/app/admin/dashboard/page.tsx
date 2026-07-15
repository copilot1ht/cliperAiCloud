import { AppShell } from "@/components/app-shell";
import { providerData, routingRules, recentUsage } from "@/lib/demo-data";
import { Activity, BadgeDollarSign, Cpu, Layers, Plus, ShieldCheck, Users, Zap } from "lucide-react";

export default function AdminDashboardPage() {
  return (
    <AppShell role="admin" eyebrow="Administration" title="SaaS manager dashboard" actions={<button className="button button-primary"><Zap size={16} /> Review actions</button>}>
      <div className="notice-line"><div><Activity size={17} /><span><strong>Admin control center.</strong> Fokus pada performa provider, user access, revenue, dan operasi routing AI.</span></div></div>

      <section className="stats-grid">
        <div className="stat-card"><span className="stat-icon tone-teal"><Users size={20} /></span><div><p>Total clients</p><strong>128</strong><small>Active & onboarded</small></div></div>
        <div className="stat-card"><span className="stat-icon tone-blue"><ShieldCheck size={20} /></span><div><p>Provider uptime</p><strong>99.93%</strong><small>Last 24 hours</small></div></div>
        <div className="stat-card"><span className="stat-icon tone-amber"><Cpu size={20} /></span><div><p>AI requests</p><strong>18.4K</strong><small>Processed today</small></div></div>
        <div className="stat-card"><span className="stat-icon tone-coral"><BadgeDollarSign size={20} /></span><div><p>MRR</p><strong>$12.4K</strong><small>Recurring revenue</small></div></div>
      </section>

      <div className="content-grid content-grid-main">
        <section className="panel">
          <div className="panel-head"><div><p className="section-kicker">Operational snapshot</p><h2>Platform health</h2><p>Ringkasan metrik utama untuk SaaS manager: user, provider, routing, serta service stability.</p></div></div>
          <div className="dashboard-grid">
            <div className="dashboard-tile"><strong>3</strong><small>Pending invites</small></div>
            <div className="dashboard-tile"><strong>1</strong><small>Provider outage</small></div>
            <div className="dashboard-tile"><strong>5</strong><small>Routing warnings</small></div>
            <div className="dashboard-tile"><strong>8</strong><small>Support tickets</small></div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><div><p className="section-kicker">Quick actions</p><h2>Admin tasks</h2><p>Jalankan task utama cepat langsung dari dashboard.</p></div></div>
          <div className="action-grid">
            <button className="button button-secondary">Invite user</button>
            <button className="button button-secondary">Add provider</button>
            <button className="button button-secondary">Update routing</button>
            <button className="button button-secondary">Review payments</button>
          </div>
        </section>
      </div>

      <section className="panel table-panel">
        <div className="panel-head"><div><p className="section-kicker">Users & plans</p><h2>Active team overview</h2><p>Kelola akses, role, dan langganan secara cepat.</p></div><button className="button button-secondary">Manage users</button></div>
        <div className="table-scroll"><table><thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Devices</th><th>Last activity</th></tr></thead><tbody>
            <tr><td><strong>andra@cliper.ai</strong><small>Andra Irawan</small></td><td>Pro</td><td><span className="status-tag healthy">Active</span></td><td>2 / 2</td><td>Today</td></tr>
            <tr><td><strong>studio@cliper.cloud</strong><small>Cliper Studio</small></td><td>Enterprise</td><td><span className="status-tag healthy">Active</span></td><td>6 / 8</td><td>1 hour ago</td></tr>
            <tr><td><strong>billing@cliper.ai</strong><small>Finance team</small></td><td>Pro</td><td><span className="status-tag fallback">Pending</span></td><td>0 / 2</td><td>3 days ago</td></tr>
          </tbody></table></div>
      </section>

      <section className="panel" id="providers">
        <div className="panel-head"><div><p className="section-kicker">Provider health</p><h2>AI provider status</h2><p>Monitor pool provider dan status gateway untuk keputusan routing yang cepat.</p></div><button className="button button-primary"><Plus size={14} /> Add provider</button></div>
        <div className="provider-list">
          {providerData.map((provider) => (
            <div className="provider-row" key={provider.code}>
              <span className={`provider-logo ${provider.code}`}>{provider.name[0]}</span>
              <span><strong>{provider.name}</strong><small>{provider.model}</small></span>
              <span className="provider-health"><i />{provider.status}</span>
              <button className="text-button">Manage</button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel" id="routing">
        <div className="panel-head"><div><p className="section-kicker">Routing rules</p><h2>AI Router summary</h2><p>Atur prioritas dan fallback per module dengan transparansi penuh.</p></div><button className="button button-secondary">Update routing</button></div>
        <div className="routing-list">
          {routingRules.slice(0, 3).map((rule) => (
            <div className="routing-row" key={rule.module}>
              <span><strong>{rule.module}</strong><small>{rule.mode} mode</small></span>
              <span className="route-flow"><b>{rule.primary}</b> <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg> <b>{rule.fallback}</b></span>
              <span><small>Timeout</small><strong>{rule.timeout}</strong></span>
              <span><small>Budget</small><strong>{rule.budget}</strong></span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel" id="billing">
        <div className="panel-head"><div><p className="section-kicker">Revenue</p><h2>Billing snapshot</h2><p>Overview pendapatan bulanan, biaya provider, dan margin untuk admin monitoring.</p></div><span className="status-tag fallback">Sample data</span></div>
        <div className="finance-grid"><span><small>Customer billing</small><strong>$5,553.46</strong></span><span><small>Provider spend</small><strong>$4,071.20</strong></span><span><small>Gross margin</small><strong>$1,482.26</strong></span><span><small>Margin rate</small><strong>36.4%</strong></span></div>
      </section>

      <section className="panel table-panel">
        <div className="panel-head"><div><p className="section-kicker">Recent activity</p><h2>Latest admin events</h2><p>Log ringkas operasi, perubahan, dan request terbaru.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Module</th><th>Provider</th><th>Tokens</th><th>Status</th><th>Time</th></tr></thead><tbody>
            {recentUsage.slice(0, 4).map((item) => (
              <tr key={`${item.module}-${item.time}`}><td><strong>{item.module}</strong></td><td>{item.provider}</td><td>{item.tokens}</td><td><span className={item.status === "Success" ? "status-tag healthy" : "status-tag fallback"}>{item.status}</span></td><td>{item.time}</td></tr>
            ))}
          </tbody></table></div>
      </section>
    </AppShell>
  );
}
