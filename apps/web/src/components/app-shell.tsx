"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BadgeDollarSign, Bell, Boxes, ChevronDown, Cloud, CreditCard, Crown, Download, FileText, Gauge, Home, Key, Layers, LogOut, MessageCircle, Menu, Route, ScrollText, ServerCog, Settings, ShieldCheck, Sparkles, User, Users, Wallet, X, BarChart3 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiBase } from "@/lib/api-base";

const mainNav = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/projects", label: "Projects", icon: Boxes },
  { href: "/keys", label: "API Keys", icon: Key },
  { href: "/usage", label: "Usage", icon: BarChart3 },
  { href: "/billing", label: "Wallet", icon: BadgeDollarSign },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/downloads", label: "Downloads", icon: Download },
  { href: "/documentation", label: "Documentation", icon: FileText },
  { href: "/profile", label: "Profile", icon: User },
  { href: "/settings", label: "Settings", icon: Settings },
];

import { adminMenu } from "@/lib/admin-menu";

const adminNav = adminMenu;

export function AppShell({ children, title, eyebrow, actions, role = "member" }: { children: React.ReactNode; title: string; eyebrow: string; actions?: React.ReactNode; role?: "member" | "admin" }) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<"checking" | "ready" | "setup" | "offline">("checking");
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (role !== "admin" || pathname !== "/admin/overview") return;
    const legacyRoutes: Record<string, string> = {
      "#users": "/admin/users",
      "#providers": "/admin/providers",
      "#routing": "/admin/ai-router",
      "#billing": "/admin/revenue",
      "#payments": "/admin/payments",
      "#settings": "/admin/settings",
    };
    const target = legacyRoutes[window.location.hash];
    if (target) window.location.replace(target);
  }, [pathname, role]);

  const isActive = (href: string) => {
    if (href === "/admin/overview" || href === "/dashboard") return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  };
  const navigation = role === "admin" ? adminNav : mainNav;

  useEffect(() => {
    const apiUrl = apiBase();
    const controller = new AbortController();
    fetch(`${apiUrl.replace(/\/$/, "")}/health/ready`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((payload) => setGatewayStatus(payload?.ok ? "ready" : "setup"))
      .catch(() => setGatewayStatus("offline"));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const apiUrl = apiBase();
    fetch(`${apiUrl}/api/auth/session`, { method: "POST", credentials: "include" })
      .then(async (response) => {
        const session = await response.json();
        if (!response.ok || session?.role !== role) throw new Error("role-mismatch");
        setAuthReady(true);
      })
      .catch(() => {
        sessionStorage.removeItem("cliper_role");
        sessionStorage.removeItem("cliper_user");
        window.location.replace("/login");
      });
  }, [role]);

  const signOut = async () => {
    const apiUrl = apiBase();
    try {
      await fetch(`${apiUrl}/api/auth/logout`, { method: "POST", credentials: "include" });
    } catch {}
    sessionStorage.clear();
    window.location.assign("/login");
  };

  const gatewayLabel = {
    checking: "Checking gateway",
    ready: "Gateway ready",
    setup: "Provider setup needed",
    offline: "Gateway offline",
  }[gatewayStatus];

  if (!authReady) {
    return <main className="auth-loading"><span className="brand-mark"><Cloud size={21} /></span><strong>Cliper AI Cloud</strong><small>Memeriksa session...</small></main>;
  }

  return (
    <div className="app-frame">
      <button className="mobile-menu" aria-label="Buka navigasi" onClick={() => setOpen(true)}><Menu size={20} /></button>
      {open && <button className="nav-scrim" aria-label="Tutup navigasi" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""} ${role}`}>
        <div className="brand-row">
          <span className="brand-mark"><Cloud size={21} strokeWidth={2.4} /></span>
          <span><strong>Cliper</strong><small>AI Cloud</small></span>
          <button className="mobile-close" aria-label="Tutup navigasi" onClick={() => setOpen(false)}><X size={19} /></button>
        </div>
        <div className="workspace-switcher">
          <span className="workspace-icon"><Boxes size={17} /></span>
          <span><small>Workspace</small><strong>Cliper Studio</strong></span>
          <ChevronDown size={15} />
        </div>
        <nav aria-label="Navigasi utama">
          <p className="nav-label">{role === "admin" ? "Administration" : "Cloud"}</p>
          {navigation.map((item) => <Link key={item.href} href={item.href} className={isActive(item.href) ? "nav-link active" : "nav-link"} onClick={() => setOpen(false)}><item.icon size={18} /><span>{item.label}</span></Link>)}
        </nav>
        <div className="sidebar-foot">
          <Link href={role === "admin" ? "/admin/settings" : "/settings"} className={isActive(role === "admin" ? "/admin/settings" : "/settings") ? "nav-link active" : "nav-link"}><Settings size={18} /><span>Settings</span></Link>
          <button className="nav-link nav-button" onClick={signOut}><LogOut size={18} /><span>Sign out</span></button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>
          <div className="topbar-actions">
            <span className="status-pill alpha-pill">Private alpha</span>
            <span className="status-pill"><span className={`status-dot ${gatewayStatus}`} /> {gatewayLabel}</span>
            {actions}
            <button className="avatar" aria-label="Account menu">AU</button>
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}

export function SecurityBadge() {
  return <span className="security-badge"><ShieldCheck size={15} /> Provider keys server-side</span>;
}
