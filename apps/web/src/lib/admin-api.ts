export type PlanCode = "free" | "starter" | "pro" | "enterprise";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  plan: PlanCode;
  status: "active" | "suspended";
  credits: number;
  deviceLimit: number;
  createdAt: string;
  lastActiveAt: string;
  protected: boolean;
}

export interface AdminPlan {
  code: PlanCode;
  name: string;
  priceIdr: number;
  credits: number;
  deviceLimit: number;
  active: boolean;
}

export interface AdminProvider {
  id: string;
  code: string;
  displayName: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  inputUsdPerM: number;
  outputUsdPerM: number;
  updatedAt: string;
  keyCount: number;
  configured: boolean;
  keyPreview: string;
  status: "ready" | "needs-key" | "disabled";
}

export interface RoutingRule {
  id: string;
  module: string;
  plan: PlanCode;
  primary: string;
  fallback: string;
  timeoutMs: number;
  maxTokens: number;
  enabled: boolean;
}

export interface PaymentRecord {
  id: string;
  reference: string;
  customerEmail: string;
  amountIdr: number;
  method: string;
  status: "paid" | "pending" | "failed" | "refunded";
  createdAt: string;
  updatedAt: string;
}

export interface PricingPolicy {
  markupBps: number;
  computeCostMicroUsd: number;
  paymentFeeBps: number;
  reserveBps: number;
  minimumChargeMicroUsd: number;
  microUsdPerCredit: number;
  updatedAt: string;
}

export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4100").replace(/\/$/, "");
}

export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join(" ") : payload?.message;
    throw new Error(message || `Request gagal (${response.status}).`);
  }
  return payload as T;
}

export function formatIdr(value: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0));
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(value || 0));
}

export function formatDate(value: string): string {
  if (!value) return "Belum pernah";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
