import type { LucideIcon } from "lucide-react";

export function StatCard({ label, value, detail, trend, icon: Icon, tone = "teal" }: { label: string; value: string; detail: string; trend?: string; icon: LucideIcon; tone?: "teal" | "coral" | "blue" | "amber" }) {
  return (
    <article className="stat-card">
      <div className={`stat-icon tone-${tone}`}><Icon size={19} /></div>
      <div className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
      {trend && <b className="trend">{trend}</b>}
    </article>
  );
}
