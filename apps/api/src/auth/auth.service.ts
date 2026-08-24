import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { DatabaseService } from "../database/database.service.js";
import { KeyStatus, LedgerType, PlanCode, Prisma, UserRole } from "../generated/prisma/client.js";
import { SecurityEventService } from "../security/security-event.service.js";

export type AuthRole = "admin" | "investor" | "member";
export type MemberPlan = "free" | "starter" | "pro" | "enterprise";
export type MemberStatus = "active" | "suspended" | "deleted";
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
  passwordResetRequiredAt?: number;
  deletedAt?: string;
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
  deletedAt: Date | null;
  lastActiveAt: Date | null;
  passwordResetRequiredAt: Date | null;
  createdAt: Date;
  creditAccount: { balanceMicro: bigint } | null;
  passwordResetCredentials?: Array<{ expiresAt: Date }>;
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

export interface PasswordResetLoginResult {
  ok: true;
  mode: AuthStorageMode;
  authState: "PASSWORD_RESET_REQUIRED";
  resetToken: string;
  expiresAt: string;
  redirectTo: "/change-password";
}

export type LoginResult = AuthResult | PasswordResetLoginResult;

export interface PasswordResetSessionResult {
  ok: true;
  authState: "PASSWORD_RESET_REQUIRED";
  expiresAt: string;
}

interface MemoryPasswordResetToken {
  userId: string;
  expiresAt: number;
  consumedAt?: number;
}

interface MemoryPasswordResetCredential {
  id: string;
  userId: string;
  credentialHash: string;
  expiresAt: number;
  usedAt?: number;
  revokedAt?: number;
  createdByAdminId?: string;
}

interface MemoryPasswordResetSession {
  userId: string;
  credentialId: string;
  expiresAt: number;
  consumedAt?: number;
  revokedAt?: number;
}

export interface AdminPasswordResetResult {
  ok: true;
  temporaryPassword: string;
  expiresAt: string;
  resetId: string;
  sessionsRevoked: true;
}

export interface PasswordResetRequestResult {
  ok: true;
  message: string;
  // Development-only test aid. It is never included when NODE_ENV=production.
  resetToken?: string;
  resetUrl?: string;
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

function escapeHtml(value: string): string {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] || character));
}
async function passwordMatches(passwordHash: string, password: string): Promise<boolean> {
  const normalizedHash = String(passwordHash || "").trim();
  if (!normalizedHash.startsWith("$argon2")) return false;
  try {
    return await verify(normalizedHash, password);
  } catch {
    return false;
  }
}

function passwordRecoveryMode(): "admin_assisted" | "email_link" {
  return String(process.env.PASSWORD_RECOVERY_MODE || "admin_assisted").trim().toLowerCase() === "email_link"
    ? "email_link"
    : "admin_assisted";
}

function configuredResetTtlMinutes(): number {
  const value = Number(process.env.PASSWORD_RESET_TEMP_TTL_MINUTES || "30");
  return Number.isFinite(value) ? Math.max(5, Math.min(120, Math.round(value))) : 30;
}

function temporaryPassword(): string {
  // randomInt uses the system CSPRNG and avoids modulo bias while keeping the
  // password readable enough for an administrator to relay once.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const section = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `Clp-${section()}-${section()}-${section()}`;
}

function validNewPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 128 && /\S/.test(password);
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
  private readonly passwordResetTokens = new Map<string, MemoryPasswordResetToken>();
  private readonly passwordResetCredentials = new Map<string, MemoryPasswordResetCredential>();
  private readonly passwordResetSessions = new Map<string, MemoryPasswordResetSession>();
  private readonly loginAttempts = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();

  constructor(
    @Optional() @Inject(CreditAccountService) private readonly creditAccounts?: CreditAccountService,
    @Optional() @Inject(SecurityEventService) private readonly securityEvents?: SecurityEventService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {}

  async register(input: { email?: string; password?: string; displayName?: string }): Promise<AuthResult> {
    await this.createMember(input);
    const result = await this.login({ email: input.email, password: input.password });
    if ("authState" in result) throw new ServiceUnavailableException("Sesi pendaftaran tidak dapat dibuat.");
    this.securityEvents?.record({ event: "web_registration", severity: "info", accountId: result.user.id, detail: "Member account registered." });
    return result;
  }

  async login(input: { email?: string; password?: string }): Promise<LoginResult> {
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
        if (!user.isActive) {
          this.securityEvents?.record({ event: "web_login_suspended", severity: "warning", accountId: user.id, detail: "Login rejected for suspended account." });
          throw new UnauthorizedException("Akun sedang dinonaktifkan oleh administrator.");
        }
        if (user.passwordResetRequiredAt) {
          const resetLogin = await this.createDatabasePasswordResetSession(user, password);
          if (!resetLogin) this.rejectLogin(email);
          this.loginAttempts.delete(email);
          this.securityEvents?.record({ event: "password_reset_temp_used", severity: "info", accountId: user.id, detail: "Temporary password accepted; restricted reset session created." });
          return resetLogin;
        }
        if (!(await passwordMatches(user.passwordHash, password))) this.rejectLogin(email);
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
      if (!(await passwordMatches(configuredAdminHash, password))) this.rejectLogin(email);
      const result = this.createMemorySession(this.bootstrapAdmin(configuredAdminHash));
      this.loginAttempts.delete(email);
      this.securityEvents?.record({ event: "web_login_success", severity: "info", accountId: "bootstrap-admin", detail: "Bootstrap admin login successful." });
      return result;
    }

    const user = this.users.get(email);
    if (!user) this.rejectLogin(email);
    if (user.status !== "active") {
      this.securityEvents?.record({ event: "web_login_suspended", severity: "warning", accountId: user.id, detail: "Login rejected for suspended account." });
      throw new UnauthorizedException("Akun sedang dinonaktifkan oleh administrator.");
    }
    if (user.passwordResetRequiredAt) {
      const resetLogin = await this.createMemoryPasswordResetSession(user, password);
      if (!resetLogin) this.rejectLogin(email);
      this.loginAttempts.delete(email);
      return resetLogin;
    }
    if (!(await passwordMatches(user.passwordHash, password))) this.rejectLogin(email);
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
      if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= Date.now() || !stored.user.isActive || stored.user.passwordResetRequiredAt) {
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
    const memoryUser = session ? Array.from(this.users.values()).find((item) => item.id === session.userId) : undefined;
    if (!session || session.expiresAt <= Date.now() || Boolean(memoryUser?.passwordResetRequiredAt)) {
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

  async requestPasswordReset(input: { email?: string }): Promise<PasswordResetRequestResult> {
    const email = normalizeEmail(input.email || "");
    const genericMessage = "Jika akun terdaftar, tautan pemulihan telah dikirim ke email Anda.";
    if (passwordRecoveryMode() === "admin_assisted") {
      // Do not inspect the account in this public flow. It intentionally gives
      // the same answer to every identifier and has no email dependency.
      return {
        ok: true,
        message: "Pemulihan password dilakukan melalui admin. Hubungi support untuk mendapatkan password sementara.",
      };
    }
    if (!validEmail(email)) return { ok: true, message: genericMessage };

    const testMode = this.allowsTestResetToken();
    if (!testMode && !this.passwordResetEmailConfigured()) {
      throw new ServiceUnavailableException("Pemulihan password melalui email belum dikonfigurasi. Hubungi administrator Cliper.");
    }

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = sessionHash(rawToken);
    const resetUrl = this.passwordResetUrl(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    if (this.usesPostgres()) {
      const user = await this.database!.client().user.findUnique({ where: { email }, select: { id: true, isActive: true } });
      if (!user || !user.isActive) return { ok: true, message: genericMessage };
      const now = new Date();
      const recent = await this.database!.client().passwordResetToken.findFirst({
        where: { userId: user.id, consumedAt: null, expiresAt: { gt: now }, createdAt: { gt: new Date(Date.now() - 60_000) } },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });
      if (recent) return { ok: true, message: genericMessage };
      await this.database!.client().passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } });
      if (testMode) return { ok: true, message: genericMessage, resetToken: rawToken, resetUrl };
      try {
        await this.sendPasswordResetEmail(email, resetUrl);
      } catch (error) {
        await this.database!.client().passwordResetToken.deleteMany({ where: { tokenHash, consumedAt: null } });
        this.securityEvents?.record({ event: "password_reset_delivery_failed", severity: "critical", accountId: user.id, detail: "Password reset email delivery failed." });
        throw error;
      }
      this.securityEvents?.record({ event: "password_reset_requested", severity: "info", accountId: user.id, detail: "Password recovery email requested." });
      return { ok: true, message: genericMessage };
    }

    const user = this.users.get(email);
    if (!user || user.status !== "active") return { ok: true, message: genericMessage };
    const existing = Array.from(this.passwordResetTokens.values()).find((item) => item.userId === user.id && !item.consumedAt && item.expiresAt > Date.now());
    if (existing) return { ok: true, message: genericMessage };
    this.passwordResetTokens.set(tokenHash, { userId: user.id, expiresAt: expiresAt.getTime() });
    if (testMode) return { ok: true, message: genericMessage, resetToken: rawToken, resetUrl };
    try {
      await this.sendPasswordResetEmail(email, resetUrl);
    } catch (error) {
      this.passwordResetTokens.delete(tokenHash);
      throw error;
    }
    return { ok: true, message: genericMessage };
  }

  async confirmPasswordReset(input: { token?: string; password?: string }): Promise<{ ok: true }> {
    if (passwordRecoveryMode() === "admin_assisted") {
      throw new BadRequestException("Pemulihan melalui tautan email tidak aktif. Hubungi admin untuk mendapatkan password sementara.");
    }
    const rawToken = String(input.token || "").trim();
    const password = String(input.password || "");
    if (!rawToken || rawToken.length < 32) throw new BadRequestException("Tautan pemulihan tidak valid atau sudah kedaluwarsa.");
    if (password.length < 10) throw new BadRequestException("Password minimal 10 karakter.");
    const tokenHash = sessionHash(rawToken);
    const passwordHash = await hash(password, ARGON_OPTIONS);

    if (this.usesPostgres()) {
      const record = await this.database!.client().passwordResetToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { id: true, isActive: true } } },
      });
      if (!record || record.consumedAt || record.expiresAt.getTime() <= Date.now() || !record.user.isActive) {
        throw new BadRequestException("Tautan pemulihan tidak valid atau sudah kedaluwarsa.");
      }
      const now = new Date();
      await this.database!.client().$transaction(async (tx) => {
        const consumed = await tx.passwordResetToken.updateMany({ where: { id: record.id, consumedAt: null }, data: { consumedAt: now } });
        if (consumed.count !== 1) throw new BadRequestException("Tautan pemulihan sudah digunakan.");
        await tx.user.update({ where: { id: record.userId }, data: { passwordHash, passwordChangedAt: now } });
        await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } });
        await tx.desktopSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } });
        await tx.auditLog.create({ data: { actorId: record.userId, action: "account.password_reset_self_service", entityType: "user", entityId: record.userId, metadata: { sessionsRevoked: true } } });
      });
      this.securityEvents?.record({ event: "password_reset_completed", severity: "info", accountId: record.userId, detail: "Self-service password reset completed." });
      return { ok: true };
    }

    const record = this.passwordResetTokens.get(tokenHash);
    if (!record || record.consumedAt || record.expiresAt <= Date.now()) {
      throw new BadRequestException("Tautan pemulihan tidak valid atau sudah kedaluwarsa.");
    }
    const user = Array.from(this.users.values()).find((item) => item.id === record.userId);
    if (!user || user.status !== "active") throw new BadRequestException("Tautan pemulihan tidak valid atau sudah kedaluwarsa.");
    record.consumedAt = Date.now();
    user.passwordHash = passwordHash;
    await this.revokeUserSessions(user.id);
    return { ok: true };
  }

  async listUsers() {
    if (this.usesPostgres()) {
      const now = new Date();
      const users = await this.database!.client().user.findMany({
        include: {
          creditAccount: { select: { balanceMicro: true } },
          passwordResetCredentials: {
            where: { usedAt: null, revokedAt: null, expiresAt: { gt: now } },
            select: { expiresAt: true },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
        },
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
    walletUsd?: number;
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
    walletUsd?: number;
    unlimitedWallet?: boolean;
    deviceLimit?: number;
  }) {
    const role = input.role === "admin" || input.role === "investor" ? input.role : "member";
    return this.createAccount(input, role, Boolean(input.unlimitedWallet));
  }

  async updateMember(id: string, input: {
    displayName?: string;
    email?: string;
    status?: MemberStatus;
    walletUsd?: number;
    unlimitedWallet?: boolean;
    deviceLimit?: number;
  }, actorId?: string) {
    if (this.usesPostgres()) {
      const current = await this.database!.client().user.findUnique({
        where: { id },
        include: { creditAccount: { select: { id: true, balanceMicro: true, reservedMicro: true } } },
      });
      if (!current) throw new BadRequestException("User tidak ditemukan.");
      if (current.role === UserRole.SUPER_ADMIN) throw new BadRequestException("Akun admin yang dilindungi tidak dapat diubah dari panel.");
      if (current.deletedAt) throw new BadRequestException("Akun yang telah dihapus tidak dapat diubah.");
      const displayName = input.displayName === undefined ? undefined : this.validDisplayName(input.displayName);
      const email = input.email === undefined ? undefined : normalizeEmail(input.email);
      if (email !== undefined && !validEmail(email)) throw new BadRequestException("Format email tidak valid.");
      if (input.status === "deleted") throw new BadRequestException("Gunakan aksi hapus akun untuk menghapus member.");
      const deviceLimit = input.deviceLimit === undefined ? undefined : Math.max(1, Math.round(this.nonNegative(input.deviceLimit, current.deviceLimit)));
      const nextStatus = input.status === undefined ? undefined : input.status;
      const targetBalance = input.walletUsd === undefined
        ? undefined
        : BigInt(Math.round(this.nonNegative(input.walletUsd, 0) * 1_000_000));
      if (targetBalance !== undefined && targetBalance < (current.creditAccount?.reservedMicro || 0n)) {
        throw new BadRequestException("Saldo tidak dapat ditetapkan di bawah dana yang sedang direservasi.");
      }
      const now = new Date();
      try {
        await this.serializableTransaction(async (tx) => {
          await tx.user.update({
            where: { id },
            data: {
              ...(displayName !== undefined ? { displayName } : {}),
              ...(email !== undefined ? { email } : {}),
              ...(nextStatus !== undefined ? { isActive: nextStatus === "active" } : {}),
              ...(input.unlimitedWallet !== undefined ? { unlimitedCredits: Boolean(input.unlimitedWallet) } : {}),
              ...(deviceLimit !== undefined ? { deviceLimit } : {}),
            },
          });
          if (targetBalance !== undefined) {
            const account = current.creditAccount
              ? await tx.userCreditAccount.update({ where: { userId: id }, data: { balanceMicro: targetBalance } })
              : await tx.userCreditAccount.create({
                  data: { userId: id, balanceMicro: targetBalance, lifetimeGrantedMicro: 0n },
                });
            const previousBalance = current.creditAccount?.balanceMicro || 0n;
            const adjustment = targetBalance - previousBalance;
            if (adjustment !== 0n) {
              await tx.creditLedger.create({
                data: {
                  accountId: account.id,
                  type: LedgerType.ADJUSTMENT,
                  amountMicro: adjustment,
                  balanceAfterMicro: targetBalance,
                  idempotencyKey: `admin-wallet-adjust:${id}:${now.getTime()}:${randomUUID()}`,
                  description: "Admin wallet balance adjustment",
                  costSnapshot: { actorId: actorId || null, previousMicroUsd: previousBalance.toString(), targetMicroUsd: targetBalance.toString() },
                },
              });
            }
          }
          if (nextStatus) await this.applyPersistentAccessState(tx, id, nextStatus, now);
          await tx.auditLog.create({
            data: {
              actorId: actorId || null,
              action: nextStatus === "suspended" ? "admin.user_suspended" : nextStatus === "active" ? "admin.user_reactivated" : "admin.user_updated",
              entityType: "user",
              entityId: id,
              metadata: {
                fields: { displayName: displayName !== undefined, email: email !== undefined, walletUsd: targetBalance !== undefined, deviceLimit: deviceLimit !== undefined, unlimitedWallet: input.unlimitedWallet !== undefined },
                status: nextStatus || null,
              },
            },
          });
        });
      } catch (error) {
        if (String(error).toLowerCase().includes("unique")) throw new BadRequestException("Email sudah digunakan.");
        throw error;
      }
      if (targetBalance !== undefined) this.creditAccounts?.setBalance(id, Number(targetBalance), "admin-wallet-adjustment");
      return this.userById(id);
    }

    const user = Array.from(this.users.values()).find((item) => item.id === id);
    if (!user) throw new BadRequestException("User tidak ditemukan atau akun dilindungi.");
    if (user.status === "deleted") throw new BadRequestException("Akun yang telah dihapus tidak dapat diubah.");
    if (input.displayName !== undefined) user.displayName = this.validDisplayName(input.displayName);
    if (input.email !== undefined) {
      const email = normalizeEmail(input.email);
      if (!validEmail(email)) throw new BadRequestException("Format email tidak valid.");
      if (email !== user.email && this.users.has(email)) throw new BadRequestException("Email sudah digunakan.");
      this.users.delete(user.email);
      user.email = email;
      this.users.set(email, user);
    }
    if (input.status === "deleted") throw new BadRequestException("Gunakan aksi hapus akun untuk menghapus member.");
    if (input.status !== undefined) user.status = input.status;
    if (input.unlimitedWallet !== undefined) user.unlimitedCredits = Boolean(input.unlimitedWallet);
    if (input.walletUsd !== undefined) {
      user.credits = this.nonNegative(input.walletUsd, user.credits);
      this.creditAccounts?.setBalance(user.id, Math.round(user.credits * 1_000_000), "admin-user-credit-update");
    }
    if (input.deviceLimit !== undefined) user.deviceLimit = Math.max(1, Math.round(this.nonNegative(input.deviceLimit, user.deviceLimit)));
    if (user.status === "suspended") await this.revokeUserSessions(user.id);
    return this.safeMemoryUser(user);
  }

  async issueAdminTemporaryPassword(id: string, actorId?: string): Promise<AdminPasswordResetResult> {
    const rawPassword = temporaryPassword();
    const credentialHash = await hash(rawPassword, ARGON_OPTIONS);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + configuredResetTtlMinutes() * 60_000);

    if (this.usesPostgres()) {
      const client = this.database!.client();
      const target = await client.user.findUnique({
        where: { id },
        select: { id: true, isActive: true, deletedAt: true },
      });
      if (!target) throw new BadRequestException("Akun tidak ditemukan.");
      if (target.deletedAt || !target.isActive)
        throw new BadRequestException(
          "Reset password hanya tersedia untuk akun member yang aktif.",
        );
      const result = await this.serializableTransaction(async (tx) => {
        const actor = actorId
          ? await tx.user.findUnique({ where: { id: actorId }, select: { id: true } })
          : null;
        await tx.passwordResetCredential.updateMany({
          where: { userId: id, usedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.passwordResetSession.updateMany({
          where: { userId: id, consumedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
        await tx.desktopSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
        await tx.user.update({ where: { id }, data: { passwordResetRequiredAt: now } });
        const credential = await tx.passwordResetCredential.create({
          data: {
            userId: id,
            credentialHash,
            expiresAt,
            createdByAdminId: actor?.id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor?.id,
            action: "account.password_reset_initiated_by_admin",
            entityType: "user",
            entityId: id,
            metadata: { expiresAt: expiresAt.toISOString(), sessionsRevoked: true },
          },
        });
        return credential.id;
      });
      // Keep sensitive credential tables bounded without losing recent audit
      // information. Raw secrets are never stored in either table.
      await client.passwordResetCredential.deleteMany({
        where: { expiresAt: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60_000) } },
      });
      this.securityEvents?.record({ event: "password_reset_initiated_by_admin", severity: "warning", accountId: id, detail: "Admin-issued temporary password; sessions revoked." });
      return { ok: true, temporaryPassword: rawPassword, expiresAt: expiresAt.toISOString(), resetId: result, sessionsRevoked: true };
    }

    const user = Array.from(this.users.values()).find((item) => item.id === id);
    if (!user) throw new BadRequestException("Akun tidak ditemukan.");
    if (user.deletedAt || user.status !== "active")
      throw new BadRequestException(
        "Reset password hanya tersedia untuk akun member yang aktif.",
      );
    for (const credential of this.passwordResetCredentials.values()) {
      if (credential.userId === id && !credential.usedAt && !credential.revokedAt) credential.revokedAt = now.getTime();
    }
    for (const session of this.passwordResetSessions.values()) {
      if (session.userId === id && !session.consumedAt && !session.revokedAt) session.revokedAt = now.getTime();
    }
    const resetId = randomUUID();
    this.passwordResetCredentials.set(resetId, {
      id: resetId,
      userId: id,
      credentialHash,
      expiresAt: expiresAt.getTime(),
      createdByAdminId: actorId,
    });
    user.passwordResetRequiredAt = now.getTime();
    await this.revokeUserSessions(id);
    this.securityEvents?.record({ event: "password_reset_initiated_by_admin", severity: "warning", accountId: id, detail: "Admin-issued temporary password; sessions revoked." });
    return { ok: true, temporaryPassword: rawPassword, expiresAt: expiresAt.toISOString(), resetId, sessionsRevoked: true };
  }

  async passwordResetSession(token: string): Promise<PasswordResetSessionResult> {
    const tokenHash = sessionHash(token);
    if (!token) throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
    if (this.usesPostgres()) {
      const stored = await this.database!.client().passwordResetSession.findUnique({
        where: { tokenHash },
        include: { user: { select: { isActive: true, passwordResetRequiredAt: true } } },
      });
      if (!stored || stored.consumedAt || stored.revokedAt || stored.expiresAt.getTime() <= Date.now() || !stored.user.isActive || !stored.user.passwordResetRequiredAt) {
        throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
      }
      return { ok: true, authState: "PASSWORD_RESET_REQUIRED", expiresAt: stored.expiresAt.toISOString() };
    }
    const stored = this.passwordResetSessions.get(tokenHash);
    const user = stored ? Array.from(this.users.values()).find((item) => item.id === stored.userId) : undefined;
    if (!stored || stored.consumedAt || stored.revokedAt || stored.expiresAt <= Date.now() || !user?.passwordResetRequiredAt || user.status !== "active") {
      throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
    }
    return { ok: true, authState: "PASSWORD_RESET_REQUIRED", expiresAt: new Date(stored.expiresAt).toISOString() };
  }

  async completeTemporaryPasswordReset(token: string, password: string): Promise<AuthResult> {
    if (!validNewPassword(password)) throw new BadRequestException("Password baru minimal 12 karakter dan maksimal 128 karakter.");
    const tokenHash = sessionHash(token);
    if (!token) throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
    const passwordHash = await hash(password, ARGON_OPTIONS);
    const now = new Date();

    if (this.usesPostgres()) {
      const client = this.database!.client();
      const resetSession = await client.passwordResetSession.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!resetSession || resetSession.consumedAt || resetSession.revokedAt || resetSession.expiresAt.getTime() <= now.getTime() || !resetSession.user.isActive || !resetSession.user.passwordResetRequiredAt) {
        throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
      }
      const temporaryCredential = await client.passwordResetCredential.findUnique({
        where: { id: resetSession.credentialId },
        select: { credentialHash: true, usedAt: true, revokedAt: true, expiresAt: true },
      });
      if (!temporaryCredential || temporaryCredential.revokedAt || temporaryCredential.expiresAt.getTime() <= now.getTime()) {
        throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
      }
      if (await passwordMatches(temporaryCredential.credentialHash, password)) {
        throw new BadRequestException("Password baru harus berbeda dari password sementara.");
      }
      const normalToken = `clip_sess_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(now.getTime() + 12 * 60 * 60_000);
      const user = await this.serializableTransaction(async (tx) => {
        const consumed = await tx.passwordResetSession.updateMany({
          where: { id: resetSession.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) throw new UnauthorizedException("Sesi reset password sudah digunakan atau berakhir.");
        const updatedUser = await tx.user.updateMany({
          where: {
            id: resetSession.userId,
            isActive: true,
            passwordResetRequiredAt: { not: null },
          },
          data: { passwordHash, passwordChangedAt: now, passwordResetRequiredAt: null, lastActiveAt: now },
        });
        if (updatedUser.count !== 1) throw new UnauthorizedException("Sesi reset password sudah digunakan atau berakhir.");
        const updated = await tx.user.findUnique({ where: { id: resetSession.userId } });
        if (!updated) throw new UnauthorizedException("Sesi reset password sudah berakhir.");
        await tx.session.updateMany({ where: { userId: updated.id, revokedAt: null }, data: { revokedAt: now } });
        await tx.desktopSession.updateMany({ where: { userId: updated.id, revokedAt: null }, data: { revokedAt: now } });
        await tx.passwordResetCredential.updateMany({ where: { userId: updated.id, revokedAt: null }, data: { revokedAt: now } });
        await tx.passwordResetSession.updateMany({ where: { userId: updated.id, id: { not: resetSession.id }, revokedAt: null }, data: { revokedAt: now } });
        await tx.session.create({
          data: { userId: updated.id, tokenFamily: randomUUID(), refreshTokenHash: sessionHash(normalToken), expiresAt },
        });
        await tx.auditLog.create({
          data: {
            actorId: updated.id,
            action: "account.password_changed_after_admin_reset",
            entityType: "user",
            entityId: updated.id,
            metadata: { sessionsRevoked: true },
          },
        });
        return updated;
      });
      this.securityEvents?.record({ event: "password_changed_after_reset", severity: "info", accountId: user.id, detail: "Temporary credential consumed and normal session issued." });
      const role = roleFromDatabase(user.role);
      return {
        ok: true,
        mode: "postgresql",
        token: normalToken,
        expiresAt: expiresAt.toISOString(),
        user: { id: user.id, email: user.email, displayName: user.displayName, role },
        redirectTo: role === "member" ? "/dashboard" : "/admin/overview",
      };
    }

    const resetSession = this.passwordResetSessions.get(tokenHash);
    const user = resetSession ? Array.from(this.users.values()).find((item) => item.id === resetSession.userId) : undefined;
    if (!resetSession || resetSession.consumedAt || resetSession.revokedAt || resetSession.expiresAt <= now.getTime() || !user?.passwordResetRequiredAt || user.status !== "active") {
      throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
    }
    const temporaryCredential = this.passwordResetCredentials.get(resetSession.credentialId);
    if (!temporaryCredential || temporaryCredential.revokedAt || temporaryCredential.expiresAt <= now.getTime()) {
      throw new UnauthorizedException("Sesi reset password tidak valid atau sudah berakhir.");
    }
    if (await passwordMatches(temporaryCredential.credentialHash, password)) {
      throw new BadRequestException("Password baru harus berbeda dari password sementara.");
    }
    resetSession.consumedAt = now.getTime();
    for (const credential of this.passwordResetCredentials.values()) if (credential.userId === user.id && !credential.revokedAt) credential.revokedAt = now.getTime();
    for (const session of this.passwordResetSessions.values()) if (session.userId === user.id && session !== resetSession && !session.revokedAt) session.revokedAt = now.getTime();
    user.passwordHash = passwordHash;
    user.passwordResetRequiredAt = undefined;
    user.lastActiveAt = now.toISOString();
    await this.revokeUserSessions(user.id);
    return this.createMemorySession(user);
  }

  async deleteMember(id: string, actorId?: string) {
    if (this.usesPostgres()) {
      const user = await this.database!.client().user.findUnique({ where: { id }, select: { id: true, role: true, deletedAt: true } });
      if (!user) throw new BadRequestException("User tidak ditemukan.");
      if (user.role !== UserRole.MEMBER) throw new BadRequestException("Akun admin/investor tidak dapat dihapus dari panel.");
      if (user.deletedAt) return { ok: true, duplicate: true, status: "deleted" as const };
      const now = new Date();
      const anonymizedEmail = `deleted-${id}@deleted.cliper.invalid`;
      await this.serializableTransaction(async (tx) => {
        await this.applyPersistentAccessState(tx, id, "suspended", now);
        await Promise.all([
          tx.apiKey.updateMany({
            where: { userId: id, status: { not: KeyStatus.REVOKED } },
            data: { status: KeyStatus.REVOKED },
          }),
          tx.license.updateMany({
            where: { userId: id, status: { not: KeyStatus.REVOKED } },
            data: { status: KeyStatus.REVOKED, revokedAt: now },
          }),
        ]);
        await tx.passwordResetToken.updateMany({ where: { userId: id, consumedAt: null }, data: { consumedAt: now } });
        await tx.user.update({
          where: { id },
          data: {
            email: anonymizedEmail,
            displayName: "Deleted member",
            passwordHash: `deleted:${randomUUID()}`,
            passwordResetRequiredAt: null,
            isActive: false,
            deletedAt: now,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actorId || null,
            action: "admin.user_deleted",
            entityType: "user",
            entityId: id,
            metadata: { deletionMode: "soft_delete_anonymized", financialHistoryRetained: true },
          },
        });
      });
      return { ok: true, status: "deleted" as const };
    }
    const entry = Array.from(this.users.entries()).find(([, user]) => user.id === id);
    if (!entry) throw new BadRequestException("User tidak ditemukan atau akun dilindungi.");
    const user = entry[1];
    if (user.role !== "member") throw new BadRequestException("Akun admin/investor tidak dapat dihapus dari panel.");
    if (user.status === "deleted") return { ok: true, duplicate: true, status: "deleted" as const };
    this.users.delete(entry[0]);
    user.email = `deleted-${user.id}@deleted.cliper.invalid`;
    user.displayName = "Deleted member";
    user.passwordHash = `deleted:${randomUUID()}`;
    user.status = "deleted";
    user.deletedAt = new Date().toISOString();
    this.users.set(user.email, user);
    await this.revokeUserSessions(id);
    return { ok: true, status: "deleted" as const };
  }

  async userById(id: string) {
    if (this.usesPostgres()) {
      const now = new Date();
      const user = await this.database!.client().user.findUnique({
        where: { id },
        include: {
          creditAccount: { select: { balanceMicro: true } },
          passwordResetCredentials: {
            where: { usedAt: null, revokedAt: null, expiresAt: { gt: now } },
            select: { expiresAt: true },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
        },
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
          ...(input.deviceLimit !== undefined ? { deviceLimit: Math.max(1, Math.round(input.deviceLimit)) } : {}),
        },
      });
    } else {
      const user = Array.from(this.users.values()).find((item) => item.id === id);
      if (user) {
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
    input: { email?: string; password?: string; displayName?: string; plan?: MemberPlan; walletUsd?: number; deviceLimit?: number },
    role: AuthRole,
    unlimitedCredits: boolean,
  ) {
    const email = normalizeEmail(input.email || "");
    const password = String(input.password || "");
    const displayName = this.validDisplayName(input.displayName || "");
    if (!validEmail(email)) throw new BadRequestException("Format email tidak valid.");
    if (!validNewPassword(password)) throw new BadRequestException("Password minimal 12 karakter dan maksimal 128 karakter.");
    const plan = this.validPlan(input.plan || (role === "member" ? "free" : "enterprise"));
    const credits = this.nonNegative(input.walletUsd, this.defaultWalletUsd(plan));
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

  private async createDatabasePasswordResetSession(user: DatabaseUserRecord, password: string): Promise<PasswordResetLoginResult | null> {
    const client = this.database!.client();
    const now = new Date();
    const credential = await client.passwordResetCredential.findFirst({
      where: { userId: user.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    if (!credential || !(await passwordMatches(credential.credentialHash, password))) return null;
    const token = `clip_reset_${randomBytes(32).toString("base64url")}`;
    const result = await this.serializableTransaction(async (tx) => {
      const used = await tx.passwordResetCredential.updateMany({
        where: { id: credential.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (used.count !== 1) return null;
      await tx.passwordResetSession.create({
        data: { userId: user.id, credentialId: credential.id, tokenHash: sessionHash(token), expiresAt: credential.expiresAt },
      });
      await tx.user.update({ where: { id: user.id }, data: { lastActiveAt: now } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "account.password_reset_temp_used",
          entityType: "user",
          entityId: user.id,
          metadata: { expiresAt: credential.expiresAt.toISOString() },
        },
      });
      return { expiresAt: credential.expiresAt };
    });
    if (!result) return null;
    return {
      ok: true,
      mode: "postgresql",
      authState: "PASSWORD_RESET_REQUIRED",
      resetToken: token,
      expiresAt: result.expiresAt.toISOString(),
      redirectTo: "/change-password",
    };
  }

  private async createMemoryPasswordResetSession(user: MemoryUser, password: string): Promise<PasswordResetLoginResult | null> {
    const now = Date.now();
    const credential = Array.from(this.passwordResetCredentials.values())
      .filter((item) => item.userId === user.id && !item.usedAt && !item.revokedAt && item.expiresAt > now)
      .sort((left, right) => right.expiresAt - left.expiresAt)[0];
    if (!credential || !(await passwordMatches(credential.credentialHash, password))) return null;
    credential.usedAt = now;
    const token = `clip_reset_${randomBytes(32).toString("base64url")}`;
    this.passwordResetSessions.set(sessionHash(token), {
      userId: user.id,
      credentialId: credential.id,
      expiresAt: credential.expiresAt,
    });
    user.lastActiveAt = new Date(now).toISOString();
    return {
      ok: true,
      mode: authStorageMode(),
      authState: "PASSWORD_RESET_REQUIRED",
      resetToken: token,
      expiresAt: new Date(credential.expiresAt).toISOString(),
      redirectTo: "/change-password",
    };
  }

  private async serializableTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const client = this.database!.client();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await client.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 10_000,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < 3
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ServiceUnavailableException("Reset password tidak dapat diproses. Silakan coba lagi.");
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
    const { passwordHash: _passwordHash, credits, unlimitedCredits, plan: _plan, ...safe } = user;
    const activeCredential = Array.from(this.passwordResetCredentials.values())
      .find((item) => item.userId === user.id && !item.usedAt && !item.revokedAt && item.expiresAt > Date.now());
    return {
      ...safe,
      billingMode: "wallet" as const,
      walletUsd: credits,
      unlimitedWallet: unlimitedCredits,
      passwordRecovery: {
        mode: "admin-assisted" as const,
        status: user.passwordResetRequiredAt ? "reset_required" as const : "normal" as const,
        expiresAt: activeCredential ? new Date(activeCredential.expiresAt).toISOString() : null,
      },
      protected: false,
    };
  }

  private safeDatabaseUser(user: DatabaseUserRecord) {
    const activeCredential = user.passwordResetCredentials?.[0];
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: roleFromDatabase(user.role),
      billingMode: "wallet" as const,
      status: user.deletedAt ? "deleted" as const : user.isActive ? "active" as const : "suspended" as const,
      walletUsd: Number(user.creditAccount?.balanceMicro || 0n) / 1_000_000,
      unlimitedWallet: user.unlimitedCredits,
      deviceLimit: user.deviceLimit,
      createdAt: user.createdAt.toISOString(),
      lastActiveAt: user.lastActiveAt?.toISOString() || "",
      passwordRecovery: {
        mode: "admin-assisted" as const,
        status: user.passwordResetRequiredAt ? "reset_required" as const : "normal" as const,
        expiresAt: activeCredential?.expiresAt.toISOString() || null,
      },
      protected: user.role === UserRole.SUPER_ADMIN,
    };
  }

  private async revokeUserSessions(userId: string): Promise<void> {
    if (this.usesPostgres()) {
      const now = new Date();
      await this.database!.client().$transaction([
        this.database!.client().session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
        this.database!.client().desktopSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      ]);
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

  private defaultWalletUsd(_plan: MemberPlan): number {
    // A plan defines product access; only a verified payment funds a user wallet.
    return 0;
  }

  private async applyPersistentAccessState(
    tx: Prisma.TransactionClient,
    userId: string,
    status: "active" | "suspended",
    now: Date,
  ): Promise<void> {
    if (status === "active") return;
    // Account access is gated by user.isActive in every web, desktop, and API
    // key verifier. Keep key state independent so reactivating an account can
    // never revive a key that an administrator suspended explicitly.
    await Promise.all([
      tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      tx.desktopSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      tx.passwordResetCredential.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.passwordResetSession.updateMany({ where: { userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.device.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
  }

  private nonNegative(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
  }

  private allowsTestResetToken(): boolean {
    return String(process.env.NODE_ENV || "development").toLowerCase() !== "production" &&
      String(process.env.PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS || "").toLowerCase() === "true";
  }

  private passwordResetEmailConfigured(): boolean {
    return Boolean(String(process.env.RESEND_API_KEY || "").trim() && String(process.env.PASSWORD_RESET_FROM || "").trim());
  }

  private passwordResetUrl(token: string): string {
    const configured = String(process.env.APP_URL || process.env.WEB_ORIGIN || "").split(",")[0]?.trim();
    const fallback = String(process.env.NODE_ENV || "development").toLowerCase() === "production" ? "" : "http://localhost:3000";
    try {
      const target = new URL(configured || fallback);
      if (String(process.env.NODE_ENV || "development").toLowerCase() === "production" && target.protocol !== "https:") {
        throw new Error("insecure password reset URL");
      }
      target.pathname = "/reset-password";
      target.search = "";
      target.searchParams.set("token", token);
      return target.toString();
    } catch {
      throw new ServiceUnavailableException("URL aplikasi untuk pemulihan password belum dikonfigurasi dengan aman.");
    }
  }

  private async sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
    const apiKey = String(process.env.RESEND_API_KEY || "").trim();
    const from = String(process.env.PASSWORD_RESET_FROM || "").trim();
    if (!apiKey || !from) throw new ServiceUnavailableException("Pemulihan password melalui email belum dikonfigurasi. Hubungi administrator Cliper.");
    const replyTo = String(process.env.PASSWORD_RESET_REPLY_TO || "").trim();
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject: "Reset password Cliper AI Cloud",
        text: `Gunakan tautan ini untuk membuat password baru. Tautan berlaku 30 menit dan hanya dapat digunakan sekali: ${resetUrl}`,
        html: `<p>Gunakan tautan berikut untuk membuat password baru. Tautan berlaku <strong>30 menit</strong> dan hanya dapat digunakan sekali.</p><p><a href="${escapeHtml(resetUrl)}">Reset password Cliper AI Cloud</a></p><p>Jika Anda tidak meminta perubahan ini, abaikan email ini.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException("Email pemulihan belum dapat dikirim. Coba lagi beberapa saat atau hubungi administrator.");
    }
  }
}
