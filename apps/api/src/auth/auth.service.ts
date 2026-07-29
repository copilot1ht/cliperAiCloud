import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { DatabaseService } from "../database/database.service.js";
import { PlanCode, UserRole } from "../generated/prisma/client.js";
import { SecurityEventService } from "../security/security-event.service.js";

export type AuthRole = "admin" | "investor" | "member";
export type MemberPlan = "free" | "starter" | "pro" | "enterprise";
export type MemberStatus = "active" | "suspended";
export type AuthStorageMode = "postgresql" | "development-memory" | "bootstrap-memory";

interface MemoryUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: AuthRole;
  plan: MemberPlan;
  status: MemberStatus;
  credits: number;
  unlimitedCredits: boolean;
  deviceLimit: number;
  createdAt: string;
  lastActiveAt: string;
}

interface DatabaseUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: UserRole;
  planCode: PlanCode;
  deviceLimit: number;
  unlimitedCredits: boolean;
  isActive: boolean;
  lastActiveAt: Date | null;
  createdAt: Date;
  creditAccount: { balanceMicro: bigint } | null;
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
  mode: AuthStorageMode;
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

function sessionHash(token: string): string {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function authStorageMode(): AuthStorageMode {
  if (String(process.env.AUTH_STORAGE || "").toLowerCase() === "memory") {
    return String(process.env.NODE_ENV || "development").toLowerCase() === "production" ? "bootstrap-memory" : "development-memory";
  }
  if (String(process.env.DATABASE_URL || "").trim()) return "postgresql";
  return String(process.env.NODE_ENV || "development").toLowerCase() === "production" ? "bootstrap-memory" : "development-memory";
}

function adminEmail(): string {
  const production = String(process.env.NODE_ENV || "development").toLowerCase() === "production";
  return normalizeEmail(production
    ? process.env.BOOTSTRAP_ADMIN_EMAIL || ""
    : process.env.DEV_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || "");
}

function adminPasswordHash(): string {
  const production = String(process.env.NODE_ENV || "development").toLowerCase() === "production";
  return String(production
    ? process.env.BOOTSTRAP_ADMIN_PASSWORD_HASH || ""
    : process.env.DEV_ADMIN_PASSWORD_HASH || process.env.BOOTSTRAP_ADMIN_PASSWORD_HASH || "");
}

function roleFromDatabase(role: UserRole): AuthRole {
  if (role === UserRole.SUPER_ADMIN || role === UserRole.ADMIN) return "admin";
  if (role === UserRole.INVESTOR) return "investor";
  return "member";
}

function roleForDatabase(role: AuthRole): UserRole {
  if (role === "admin") return UserRole.ADMIN;
  if (role === "investor") return UserRole.INVESTOR;
  return UserRole.MEMBER;
}

function planFromDatabase(plan: PlanCode): MemberPlan {
  if (plan === PlanCode.STARTER) return "starter";
  if (plan === PlanCode.PRO) return "pro";
  if (plan === PlanCode.ENTERPRISE || plan === PlanCode.TEAM) return "enterprise";
  return "free";
}

function planForDatabase(plan: MemberPlan): PlanCode {
  if (plan === "starter") return PlanCode.STARTER;
  if (plan === "pro") return PlanCode.PRO;
  if (plan === "enterprise") return PlanCode.ENTERPRISE;
  return PlanCode.FREE;
}

@Injectable()
export class AuthService {
  private readonly users = new Map<string, MemoryUser>();
  private readonly sessions = new Map<string, MemorySession>();
  private readonly loginAttempts = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();

  constructor(
    @Optional() @Inject(CreditAccountService) private readonly creditAccounts?: CreditAccountService,
    @Optional() @Inject(SecurityEventService) private readonly securityEvents?: SecurityEventService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {}

  async register(input: { email?: string; password?: string; displayName?: string }): Promise<AuthResult> {
    await this.createMember(input);
    const result = await this.login({ email: input.email, password: input.password });
    this.securityEvents?.record({ event: "web_registration", severity: "info", accountId: result.user.id, detail: "Member account registered." });
    return result;
  }

  async login(input: { email?: string; password?: string }): Promise<AuthResult> {
    const email = normalizeEmail(input.email || "");
    const password = String(input.password || "");
    this.assertLoginAllowed(email);
    if (!validEmail(email) || !password) this.rejectLogin(email);

    if (this.usesPostgres()) {
      const user = await this.database!.client().user.findUnique({
        where: { email },
        include: { creditAccount: { select: { balanceMicro: true } } },
      }) as DatabaseUserRecord | null;
      if (user) {
        if (!(await verify(user.passwordHash, password))) this.rejectLogin(email);
        if (!user.isActive) {
          this.securityEvents?.record({ event: "web_login_suspended", severity: "warning", accountId: user.id, detail: "Login rejected for suspended account." });
          throw new UnauthorizedException("Akun sedang dinonaktifkan oleh administrator.");
        }
        await this.database!.client().user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
        this.loginAttempts.delete(email);
        this.securityEvents?.record({ event: "web_login_success", severity: "info", accountId: user.id, detail: `${roleFromDatabase(user.role)} login successful.` });
        return this.createDatabaseSession(user);
      }

      // Once PostgreSQL is active, every account must exist in the database.
      // Falling through to the legacy memory-only bootstrap session creates a
      // cookie that the database-backed /session endpoint cannot validate.
      this.rejectLogin(email);
    }

    const configuredAdminEmail = adminEmail();
    const configuredAdminHash = adminPasswordHash();
    if (email === configuredAdminEmail) {
      if (!configuredAdminHash || !(await verify(configuredAdminHash, password))) this.rejectLogin(email);
      const result = this.createMemorySession(this.bootstrapAdmin(configuredAdminHash));
      this.loginAttempts.delete(email);
      this.securityEvents?.record({ event: "web_login_success", severity: "info", accountId: "bootstrap-admin", detail: "Bootstrap admin login successful." });
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
    this.securityEvents?.record({ event: "web_login_success", severity: "info", accountId: user.id, detail: `${user.role} login successful.` });
    return this.createMemorySession(user);
  }

  async session(token: string): Promise<Omit<MemorySession, "token">> {
    if (this.usesPostgres()) {
      const stored = await this.database!.client().session.findUnique({
        where: { refreshTokenHash: sessionHash(token) },
        include: { user: true },
      });
      if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= Date.now() || !stored.user.isActive) {
        throw new UnauthorizedException("Session tidak valid atau sudah berakhir.");
      }
      return {
        userId: stored.user.id,
        email: stored.user.email,
        displayName: stored.user.displayName,
        role: roleFromDatabase(stored.user.role),
        expiresAt: stored.expiresAt.getTime(),
      };
    }
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(token);
      throw new UnauthorizedException("Session tidak valid atau sudah berakhir.");
    }
    const { token: _token, ...safeSession } = session;
    return safeSession;
  }

  async logout(token: string): Promise<{ ok: true }> {
    if (this.usesPostgres()) {
      await this.database!.client().session.updateMany({
        where: { refreshTokenHash: sessionHash(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else if (token) {
      this.sessions.delete(token);
    }
    return { ok: true };
  }

  async listUsers() {
    if (this.usesPostgres()) {
      const users = await this.database!.client().user.findMany({
        include: { creditAccount: { select: { balanceMicro: true } } },
        orderBy: { createdAt: "asc" },
      }) as DatabaseUserRecord[];
      return users.map((user) => this.safeDatabaseUser(user));
    }
    const admin = { ...this.safeMemoryUser(this.bootstrapAdmin()), protected: true };
    return [admin, ...Array.from(this.users.values()).map((user) => this.safeMemoryUser(user))];
  }

  async createMember(input: {
    email?: string;
    password?: string;
    displayName?: string;
    plan?: MemberPlan;
    credits?: number;
    deviceLimit?: number;
  }) {
    return this.createAccount(input, "member", false);
  }

  async createManagedAccount(input: {
    email?: string;
    password?: string;
    displayName?: string;
    role?: AuthRole;
    plan?: MemberPlan;
    credits?: number;
    unlimitedCredits?: boolean;
    deviceLimit?: number;
  }) {
    const role = input.role === "admin" || input.role === "investor" ? input.role : "member";
    return this.createAccount(input, role, Boolean(input.unlimitedCredits));
  }

  async updateMember(id: string, input: {
    displayName?: string;
    plan?: MemberPlan;
    status?: MemberStatus;
    credits?: number;
    unlimitedCredits?: boolean;
    deviceLimit?: number;
  }) {
    if (this.usesPostgres()) {
      const current = await this.database!.client().user.findUnique({ where: { id } });
      if (!current) throw new BadRequestException("User tidak ditemukan.");
      const displayName = input.displayName === undefined ? undefined : this.validDisplayName(input.displayName);
      const plan = input.plan === undefined ? undefined : planForDatabase(this.validPlan(input.plan));
      const deviceLimit = input.deviceLimit === undefined ? undefined : Math.max(1, Math.round(this.nonNegative(input.deviceLimit, current.deviceLimit)));
      await this.database!.client().user.update({
        where: { id },
        data: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(plan !== undefined ? { planCode: plan } : {}),
          ...(input.status !== undefined ? { isActive: input.status !== "suspended" } : {}),
          ...(input.unlimitedCredits !== undefined ? { unlimitedCredits: Boolean(input.unlimitedCredits) } : {}),
          ...(deviceLimit !== undefined ? { deviceLimit } : {}),
        },
      });
      if (input.credits !== undefined) {
        const balanceMicro = BigInt(Math.round(this.nonNegative(input.credits, 0) * 1_000_000));
        await this.database!.client().userCreditAccount.upsert({
          where: { userId: id },
          create: { userId: id, balanceMicro, lifetimeGrantedMicro: balanceMicro },
          update: { balanceMicro },
        });
        this.creditAccounts?.setBalance(id, Number(balanceMicro), "admin-user-credit-update");
      }
      if (input.status === "suspended") await this.revokeUserSessions(id);
      return this.userById(id);
    }

    const user = Array.from(this.users.values()).find((item) => item.id === id);
    if (!user) throw new BadRequestException("User tidak ditemukan atau akun dilindungi.");
    if (input.displayName !== undefined) user.displayName = this.validDisplayName(input.displayName);
    if (input.plan !== undefined) user.plan = this.validPlan(input.plan);
    if (input.status !== undefined) user.status = input.status === "suspended" ? "suspended" : "active";
    if (input.unlimitedCredits !== undefined) user.unlimitedCredits = Boolean(input.unlimitedCredits);
    if (input.credits !== undefined) {
      user.credits = this.nonNegative(input.credits, user.credits);
      this.creditAccounts?.setBalance(user.id, Math.round(user.credits * 1_000_000), "admin-user-credit-update");
    }
    if (input.deviceLimit !== undefined) user.deviceLimit = Math.max(1, Math.round(this.nonNegative(input.deviceLimit, user.deviceLimit)));
    if (user.status === "suspended") await this.revokeUserSessions(user.id);
    return this.safeMemoryUser(user);
  }

  async resetPassword(id: string, password: string, actorId?: string) {
    const nextPassword = String(password || "");
    if (nextPassword.length < 10) throw new BadRequestException("Password minimal 10 karakter.");
    const passwordHash = await hash(nextPassword, ARGON_OPTIONS);
    if (this.usesPostgres()) {
      const user = await this.database!.client().user.findUnique({ where: { id }, select: { id: true } });
      if (!user) throw new BadRequestException("User tidak ditemukan.");
      await this.database!.client().$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: new Date() } });
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        const actorExists = actorId ? await tx.user.findUnique({ where: { id: actorId }, select: { id: true } }) : null;
        await tx.auditLog.create({
          data: {
            actorId: actorExists?.id,
            action: "account.password_reset",
            entityType: "user",
            entityId: id,
            metadata: { sessionsRevoked: true },
          },
        });
      });
      return { ok: true, sessionsRevoked: true };
    }
    const user = Array.from(this.users.values()).find((item) => item.id === id);
    if (!user) throw new BadRequestException("Password bootstrap diatur melalui secret server dan tidak dapat diubah dari UI.");
    user.passwordHash = passwordHash;
    await this.revokeUserSessions(id);
    return { ok: true, sessionsRevoked: true };
  }

  async deleteMember(id: string) {
    if (this.usesPostgres()) {
      const user = await this.database!.client().user.findUnique({ where: { id }, select: { role: true } });
      if (!user) throw new BadRequestException("User tidak ditemukan.");
      if (user.role !== UserRole.MEMBER) throw new BadRequestException("Akun admin/investor tidak dapat dihapus dari panel.");
      await this.database!.client().user.delete({ where: { id } });
      return { ok: true };
    }
    const entry = Array.from(this.users.entries()).find(([, user]) => user.id === id);
    if (!entry) throw new BadRequestException("User tidak ditemukan atau akun dilindungi.");
    this.users.delete(entry[0]);
    await this.revokeUserSessions(id);
    return { ok: true };
  }

  async userById(id: string) {
    if (this.usesPostgres()) {
      const user = await this.database!.client().user.findUnique({
        where: { id },
        include: { creditAccount: { select: { balanceMicro: true } } },
      }) as DatabaseUserRecord | null;
      if (!user) throw new UnauthorizedException("User session tidak lagi tersedia.");
      return this.safeDatabaseUser(user);
    }
    if (id === "bootstrap-admin") return { ...this.safeMemoryUser(this.bootstrapAdmin()), protected: true };
    const user = Array.from(this.users.values()).find((item) => item.id === id);
    if (!user) throw new UnauthorizedException("User session tidak lagi tersedia.");
    return this.safeMemoryUser(user);
  }

  async syncBillingState(id: string, input: { plan?: MemberPlan; balanceMicro: number; deviceLimit?: number }): Promise<void> {
    if (this.usesPostgres()) {
      await this.database!.client().user.updateMany({
        where: { id },
        data: {
          ...(input.plan ? { planCode: planForDatabase(input.plan) } : {}),
          ...(input.deviceLimit !== undefined ? { deviceLimit: Math.max(1, Math.round(input.deviceLimit)) } : {}),
        },
      });
    } else {
      const user = Array.from(this.users.values()).find((item) => item.id === id);
      if (user) {
        if (input.plan) user.plan = input.plan;
        if (input.deviceLimit !== undefined) user.deviceLimit = Math.max(1, Math.round(input.deviceLimit));
        user.credits = Math.max(0, input.balanceMicro / 1_000_000);
      }
    }
    this.creditAccounts?.setBalance(id, Math.max(0, Math.round(input.balanceMicro)), "postgresql-payment-sync");
  }

  private usesPostgres(): boolean {
    return authStorageMode() === "postgresql" && Boolean(this.database?.configured());
  }

  private async createAccount(
    input: { email?: string; password?: string; displayName?: string; plan?: MemberPlan; credits?: number; deviceLimit?: number },
    role: AuthRole,
    unlimitedCredits: boolean,
  ) {
    const email = normalizeEmail(input.email || "");
    const password = String(input.password || "");
    const displayName = this.validDisplayName(input.displayName || "");
    if (!validEmail(email)) throw new BadRequestException("Format email tidak valid.");
    if (password.length < 10) throw new BadRequestException("Password minimal 10 karakter.");
    const plan = this.validPlan(input.plan || (role === "member" ? "free" : "enterprise"));
    const credits = this.nonNegative(input.credits, this.defaultPlanCredits(plan));
    const deviceLimit = Math.max(1, Math.round(this.nonNegative(input.deviceLimit, role === "member" ? 1 : 2)));
    const passwordHash = await hash(password, ARGON_OPTIONS);

    if (this.usesPostgres()) {
      if (email === adminEmail()) {
        const existing = await this.database!.client().user.findUnique({ where: { email }, select: { id: true } });
        if (!existing) throw new BadRequestException("Email admin bootstrap dicadangkan untuk akun admin.");
      }
      const balanceMicro = BigInt(Math.round(credits * 1_000_000));
      try {
        const user = await this.database!.client().user.create({
          data: {
            email,
            displayName,
            passwordHash,
            role: roleForDatabase(role),
            planCode: planForDatabase(plan),
            deviceLimit,
            unlimitedCredits,
            creditAccount: { create: { balanceMicro, lifetimeGrantedMicro: balanceMicro } },
          },
          include: { creditAccount: { select: { balanceMicro: true } } },
        }) as DatabaseUserRecord;
        this.creditAccounts?.initialize(user.id, Number(balanceMicro));
        return this.safeDatabaseUser(user);
      } catch (error) {
        if (String(error).toLowerCase().includes("unique")) throw new BadRequestException("Email sudah digunakan.");
        throw error;
      }
    }

    if (email === adminEmail() || this.users.has(email)) throw new BadRequestException("Email sudah digunakan.");
    const now = new Date().toISOString();
    const user: MemoryUser = {
      id: randomUUID(), email, displayName, passwordHash, role, plan, status: "active", credits,
      unlimitedCredits, deviceLimit, createdAt: now, lastActiveAt: "",
    };
    this.users.set(email, user);
    this.creditAccounts?.initialize(user.id, Math.round(user.credits * 1_000_000));
    return this.safeMemoryUser(user);
  }

  private async createDatabaseSession(user: DatabaseUserRecord): Promise<AuthResult> {
    const token = `clip_sess_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await this.database!.client().session.create({
      data: {
        userId: user.id,
        tokenFamily: randomUUID(),
        refreshTokenHash: sessionHash(token),
        expiresAt,
      },
    });
    const role = roleFromDatabase(user.role);
    return {
      ok: true,
      mode: "postgresql",
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName, role },
      redirectTo: role === "member" ? "/dashboard" : "/admin/overview",
    };
  }

  private createMemorySession(user: MemoryUser): AuthResult {
    const token = `clip_sess_${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    this.sessions.set(token, { token, userId: user.id, email: user.email, displayName: user.displayName, role: user.role, expiresAt });
    return {
      ok: true,
      mode: authStorageMode(),
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      redirectTo: user.role === "member" ? "/dashboard" : "/admin/overview",
    };
  }

  private bootstrapAdmin(passwordHash = adminPasswordHash()): MemoryUser {
    const configuredLimit = Number(process.env.BOOTSTRAP_ADMIN_DEVICE_LIMIT || 2);
    return {
      id: "bootstrap-admin",
      email: adminEmail(),
      displayName: "Cliper Administrator",
      passwordHash,
      role: "admin",
      plan: "enterprise",
      status: "active",
      credits: 0,
      unlimitedCredits: true,
      deviceLimit: Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 2,
      createdAt: "",
      lastActiveAt: new Date().toISOString(),
    };
  }

  private safeMemoryUser(user: MemoryUser) {
    const { passwordHash: _passwordHash, ...safe } = user;
    return { ...safe, protected: false };
  }

  private safeDatabaseUser(user: DatabaseUserRecord) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: roleFromDatabase(user.role),
      plan: planFromDatabase(user.planCode),
      status: user.isActive ? "active" as const : "suspended" as const,
      credits: Number(user.creditAccount?.balanceMicro || 0n) / 1_000_000,
      unlimitedCredits: user.unlimitedCredits,
      deviceLimit: user.deviceLimit,
      createdAt: user.createdAt.toISOString(),
      lastActiveAt: user.lastActiveAt?.toISOString() || "",
      protected: user.role === UserRole.SUPER_ADMIN,
    };
  }

  private async revokeUserSessions(userId: string): Promise<void> {
    if (this.usesPostgres()) {
      await this.database!.client().session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return;
    }
    for (const [token, session] of this.sessions.entries()) if (session.userId === userId) this.sessions.delete(token);
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

  private validDisplayName(value: unknown): string {
    const displayName = String(value || "").trim();
    if (displayName.length < 2 || displayName.length > 80) throw new BadRequestException("Nama harus 2-80 karakter.");
    return displayName;
  }

  private defaultPlanCredits(plan: MemberPlan): number {
    return { free: 0, starter: 1_000, pro: 5_000, enterprise: 0 }[plan];
  }

  private nonNegative(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
  }
}
