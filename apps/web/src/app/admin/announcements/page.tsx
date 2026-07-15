import { AppShell } from "@/components/app-shell";

export default function AdminAnnouncementsPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Announcements">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Announcements</p><h2>System messages</h2><p>Buat update, status maintenance, atau pesan penting untuk pengguna.</p></div></div>
        <div className="readiness-list"><span><i className="ready" /><strong>Release 3.3</strong><small>New license verification flow</small></span></div>
      </section>
    </AppShell>
  );
}
