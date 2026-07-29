"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BadgeDollarSign, BarChart3, Boxes, ChevronDown, CreditCard, Download, Home, Key, LogOut, Menu, Settings, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiBase } from "@/lib/api-base";
import { adminMenu } from "@/lib/admin-menu";

const mainNav = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/usage", label: "Usage", icon: BarChart3 },
  { href: "/keys", label: "API Keys", icon: Key },
  { href: "/topup", label: "Top up", icon: CreditCard },
  { href: "/billing", label: "Billing", icon: BadgeDollarSign },
  { href: "/downloads", label: "Download app", icon: Download },
];

const adminNav = adminMenu;

interface AccountSession {
  displayName: string;
  email: string;
  role: "admin" | "investor" | "member";
}

function accountInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "CL";
  return `${words[0]?.[0] || ""}${words.length > 1 ? words[words.length - 1]?.[0] || "" : words[0]?.[1] || ""}`.toUpperCase();
}

export function AppShell({ children, title, eyebrow, actions, role = "member" }: { children: React.ReactNode; title: string; eyebrow: string; actions?: React.ReactNode; role?: "member" | "admin" }) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<"checking" | "ready" | "setup" | "offline">("checking");
  const [account, setAccount] = useState<AccountSession | null>(null);

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
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        setGatewayStatus(response.ok && payload?.ok ? "ready" : "setup");
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") setGatewayStatus("offline");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const apiUrl = apiBase();
    const controller = new AbortController();
    fetch(`${apiUrl}/api/auth/session`, { method: "POST", credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const session = await response.json().catch(() => ({}));
        if (!response.ok || !session?.role) throw new Error("invalid-session");
        const matchesArea = role === "admin" ? session.role === "admin" || session.role === "investor" : session.role === "member";
        if (!matchesArea) {
          window.location.replace(session.role === "member" ? "/dashboard" : "/admin/overview");
          return;
        }
        setAccount(session as AccountSession);
      })
      .catch((reason) => {
        if (reason?.name === "AbortError") return;
        sessionStorage.removeItem("cliper_role");
        sessionStorage.removeItem("cliper_user");
        window.location.replace("/login");
      });
    return () => controller.abort();
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

  if (!account) {
    return <main className="auth-loading"><span className="brand-mark"><Image src="/cliper-logo-mark.png" alt="" width={40} height={40} priority aria-hidden="true" /></span><strong>Cliper AI Cloud</strong><small>Memeriksa session...</small></main>;
  }

  const accountTarget = role === "admin" ? "/admin/security" : "/profile";
  const readOnly = account.role === "investor";

  return (
    <div className={`app-frame${readOnly ? " read-only" : ""}`}>
      <button className="mobile-menu" aria-label="Buka navigasi" onClick={() => setOpen(true)}><Menu size={20} /></button>
      {open && <button className="nav-scrim" aria-label="Tutup navigasi" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""} ${role}`}>
        <div className="brand-row">
          <span className="brand-mark"><Image src="/cliper-logo-mark.png" alt="Cliper" width={40} height={40} priority /></span>
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
          {role === "admin" && <Link href="/admin/settings" className={isActive("/admin/settings") ? "nav-link active" : "nav-link"}><Settings size={18} /><span>Settings</span></Link>}
          <button className="nav-link nav-button" onClick={signOut}><LogOut size={18} /><span>Sign out</span></button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>
          <div className="topbar-actions">
            <span className="status-pill alpha-pill">Local beta</span>
            <span className="status-pill"><span className={`status-dot ${gatewayStatus}`} /> {gatewayLabel}</span>
            {readOnly ? <span className="status-pill investor-pill">Investor · Read only</span> : actions}
            <Link className="avatar" href={accountTarget} aria-label={`Buka akun ${account.displayName}`} title={`${account.displayName} · ${account.email}`}>{accountInitials(account.displayName)}</Link>
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
