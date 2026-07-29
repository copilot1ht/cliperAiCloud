import type { LucideIcon } from "lucide-react";
import { BarChart3, CreditCard, Download, HeartPulse, Key, LayoutDashboard, Route, ServerCog, ShieldCheck, Users } from "lucide-react";

export interface AdminMenuItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const adminMenu: AdminMenuItem[] = [
  { href: "/admin/overview", label: "Admin Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users & Access", icon: Users },
  { href: "/admin/api-keys", label: "API Keys", icon: Key },
  { href: "/admin/providers", label: "Providers", icon: ServerCog },
  { href: "/admin/ai-router", label: "AI Router", icon: Route },
  { href: "/admin/revenue", label: "Revenue", icon: BarChart3 },
  { href: "/admin/payments", label: "Payments", icon: CreditCard },
  { href: "/admin/system-health", label: "System Health", icon: HeartPulse },
  { href: "/admin/security", label: "Security", icon: ShieldCheck },
  { href: "/admin/releases", label: "App releases", icon: Download },
];
