import { BadRequestException, HttpException, HttpStatus, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { randomBytes, randomUUID } from "node:crypto";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { SecurityEventService } from "../security/security-event.service.js";

export type AuthRole = "admin" | "member";
export type MemberPlan = "free" | "starter" | "pro" | "enterprise";
export type MemberStatus = "active" | "suspended";

interface MemoryUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: AuthRole;
  plan: MemberPlan;
  status: MemberStatus;
  credits: number;
  deviceLimit: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface MemorySession {
  token: string;
  userId: string;
  email: string;
  displayName: string;
  role: AuthRole;
  expiresAt: number;
}

export interface AuthResult {
  ok: true;
  mode: "development-memory";
  token: string;
  expiresAt: string;
  user: { id: string; email: string; displayName: string; role: AuthRole };
  redirectTo: string;
}

const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
};

function normalizeEmail(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

@Injectable()
export class AuthService {
  private readonly users = new Map<string, MemoryUser>();
  private readonly sessions = new Map<string, MemorySession>();
  private readonly loginAttempts = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();

  constructor(private readonly creditAccounts?: CreditAccountService, private readonly securityEvents?: SecurityEventService) {}

  async register(input: { email?: string; password?: string; displayName?: string }): Promise<AuthResult> {
    const user = await this.createMember(input);
    const stored = this.users.get(user.email)!;
    const result = this.createSession(stored);
    this.securityEvents?.record({ event: "web_registration", severity: "info", accountId: stored.id, detail: "Member account registered." });
    return result;
  }

  async login(input: { email?: string; password?: string }): Promise<AuthResult> {
    this.assertDevelopmentMode();
    const email = normalizeEmail(input.email || "");
    const password = String(input.password || "");
    this.assertLoginAllowed(email);
    if (!validEmail(email) || !password) this.rejectLogin(email);

    const adminEmail = normalizeEmail(process.env.DEV_ADMIN_EMAIL || "");
    const adminHash = String(process.env.DEV_ADMIN_PASSWORD_HASH || "");
    if (email === adminEmail) {
      if (!adminHash || !(await verify(adminHash, password))) this.rejectLogin(email);
      const result = this.createSession({
        id: "development-admin",
        email,
        displayName: "Cliper Administrator",
        passwordHash: adminHash,
        role: "admin",
        plan: "enterprise",
        status: "active",
        credits: 0,
        deviceLimit: 0,
        createdAt: "",
        lastActiveAt: new Date().toISOString(),
      });
      this.loginAttempts.delete(email);
      this.securityEvents?.record({ event: "web_login_success", severity: "info", accountId: "development-admin", detail: "Admin login successful." });
      return result;
    }

    const user = this.users.get(email);
    if (!user || !(await verify(user.passwordHash, password))) this.rejectLogin(email);
    if (user.status !== "active") {
      this.securityEvents?.record({ event: "web_login_suspended", severity: "warning", accountId: user.id, detail: "Login rejected for suspended account." });
      throw new UnauthorizedException("Akun sedang dinonaktifkan oleh administrator.");
    }
    user.lastActiveAt = new Date().toISOString();
    this.loginAttempts.delete(email);
    this.securityEvents?.record({ event: "web_login_success", severity: "info", accountId: user.id, detail: "Member login successful." });
    return this.createSession(user);
  }

  session(token: string): Omit<MemorySession, "token"> {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(token);
      throw new UnauthorizedException("Session tidak valid atau sudah berakhir.");
    }
    const { token: _token, ...safeSession } = session;
    return safeSession;
  }

  logout(token: string): { ok: true } {
    if (token) this.sessions.delete(token);
    return { ok: true };
  }

  listUsers() {
    const admin = {
      id: "development-admin",
      email: normalizeEmail(process.env.DEV_ADMIN_EMAIL || ""),
      displayName: "Cliper Administrator",
      role: "admin" as const,
      plan: "enterprise" as const,
      status: "active" as const,
      credits: 0,
      deviceLimit: 0,
      createdAt: "",
      lastActiveAt: "",
      protected: true,
    };
    return [admin, ...Array.from(this.users.values()).map((user) => this.safeUser(user))];
  }

  async createMember(input: {
    email?: string;
    password?: string;
    displayName?: string;
    plan?: MemberPlan;
    credits?: number;
    deviceLimit?: number;
  }) {
    this.assertDevelopmentMode();
    const email = normalizeEmail(input.email || "");
    const password = String(input.password || "");
    const displayName = String(input.displayName || "").trim();
    if (!validEmail(email)) throw new BadRequestException("Format email tidak valid.");
    if (password.length < 10) throw new BadRequestException("Password minimal 10 karakter.");
    if (displayName.length < 2 || displayName.length > 80) throw new BadRequestException("Nama harus 2-80 karakter.");
    if (email === normalizeEmail(process.env.DEV_ADMIN_EMAIL || "") || this.users.has(email)) {
      throw new BadRequestException("Email sudah digunakan.");
    }
    const now = new Date().toISOString();
    const plan = this.validPlan(input.plan);
    const user: MemoryUser = {
      id: randomUUID(),
      email,
      displayName,
      passwordHash: await hash(password, ARGON_OPTIONS),
      role: "member",
      plan,
      status: "active",
      credits: this.nonNegative(input.credits, this.defaultPlanCredits(plan)),
      deviceLimit: Math.max(1, Math.round(this.nonNegative(input.deviceLimit, 1))),
      createdAt: now,
      lastActiveAt: "",
    };
    this.users.set(email, user);
    this.creditAccounts?.initialize(user.id, Math.round(user.credits * 1_000_000));
    return this.safeUser(user);
  }

  updateMember(id: string, input: {
    displayName?: string;
    plan?: MemberPlan;
    status?: MemberStatus;
    credits?: number;
    deviceLimit?: number;
  }) {
    const user = Array.from(this.users.values()).find((item) => item.id === id);
    if (!user) throw new BadRequestException("User tidak ditemukan atau akun dilindungi.");
    if (input.displayName !== undefined) {
      const displayName = String(input.displayName).trim();
      if (displayName.length < 2 || displayName.length > 80) throw new BadRequestException("Nama harus 2-80 karakter.");
      user.displayName = displayName;
    }
    if (input.plan !== undefined) user.plan = this.validPlan(input.plan);
    if (input.status !== undefined) user.status = input.status === "suspended" ? "suspended" : "active";
    if (input.credits !== undefined) {
      user.credits = this.nonNegative(input.credits, user.credits);
      this.creditAccounts?.setBalance(user.id, Math.round(user.credits * 1_000_000), "admin-user-credit-update");
    }
    if (input.deviceLimit !== undefined) user.deviceLimit = Math.max(1, Math.round(this.nonNegative(input.deviceLimit, user.deviceLimit)));
    if (user.status === "suspended") this.revokeUserSessions(user.id);
    return this.safeUser(user);
  }

  deleteMember(id: string) {
    const entry = Array.from(this.users.entries()).find(([, user]) => user.id === id);
    if (!entry) throw new BadRequestException("User tidak ditemukan atau akun dilindungi.");
    this.users.delete(entry[0]);
    this.revokeUserSessions(id);
    return { ok: true };
  }

  userById(id: string) {
    const user = Array.from(this.users.values()).find((item) => item.id === id);
    if (!user) throw new UnauthorizedException("User session tidak lagi tersedia.");
    return this.safeUser(user);
  }

  private createSession(user: MemoryUser): AuthResult {
    const token = `clip_sess_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    this.sessions.set(token, { token, userId: user.id, email: user.email, displayName: user.displayName, role: user.role, expiresAt });
    return {
      ok: true,
      mode: "development-memory",
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      redirectTo: user.role === "admin" ? "/admin/overview" : "/dashboard",
    };
  }

  private safeUser(user: MemoryUser) {
    const { passwordHash: _passwordHash, ...safe } = user;
    return { ...safe, protected: false };
  }

  private revokeUserSessions(userId: string): void {
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === userId) this.sessions.delete(token);
    }
  }

  private assertLoginAllowed(email: string): void {
    const current = this.loginAttempts.get(email);
    if (!current) return;
    if (current.blockedUntil > Date.now()) {
      this.securityEvents?.record({ event: "web_login_throttled", severity: "warning", detail: "Login attempt blocked by account throttle." });
      throw new HttpException("Terlalu banyak percobaan login. Coba lagi beberapa menit.", HttpStatus.TOO_MANY_REQUESTS);
    }
    if (current.resetAt <= Date.now()) this.loginAttempts.delete(email);
  }

  private rejectLogin(email: string): never {
    const now = Date.now();
    const current = this.loginAttempts.get(email);
    const next = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + 15 * 60_000, blockedUntil: 0 }
      : { ...current, count: current.count + 1 };
    if (next.count >= 5) next.blockedUntil = now + 15 * 60_000;
    this.loginAttempts.set(email, next);
    this.securityEvents?.record({ event: "web_login_failed", severity: next.blockedUntil ? "critical" : "warning", detail: "Invalid login credentials rejected." });
    throw new UnauthorizedException("Email atau password salah.");
  }

  private validPlan(value: unknown): MemberPlan {
    const plan = String(value || "free").toLowerCase();
    return plan === "starter" || plan === "pro" || plan === "enterprise" ? plan : "free";
  }

  private defaultPlanCredits(plan: MemberPlan): number {
    return { free: 100, starter: 1_000, pro: 5_000, enterprise: 0 }[plan];
  }

  private nonNegative(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
  }

  private assertDevelopmentMode(): void {
    if (String(process.env.NODE_ENV || "development").toLowerCase() === "production") {
      throw new ServiceUnavailableException("Development auth dinonaktifkan pada production. Gunakan database-backed auth.");
    }
  }
}
