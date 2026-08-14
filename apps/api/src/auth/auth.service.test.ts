import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hash } from "@node-rs/argon2";
import { AuthService } from "./auth.service.js";

const original = {
  NODE_ENV: process.env.NODE_ENV,
  DEV_ADMIN_EMAIL: process.env.DEV_ADMIN_EMAIL,
  DEV_ADMIN_PASSWORD_HASH: process.env.DEV_ADMIN_PASSWORD_HASH,
  BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD_HASH: process.env.BOOTSTRAP_ADMIN_PASSWORD_HASH,
  AUTH_STORAGE: process.env.AUTH_STORAGE,
  PASSWORD_RECOVERY_MODE: process.env.PASSWORD_RECOVERY_MODE,
  PASSWORD_RESET_TEMP_TTL_MINUTES: process.env.PASSWORD_RESET_TEMP_TTL_MINUTES,
  PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS: process.env.PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS,
  WEB_ORIGIN: process.env.WEB_ORIGIN,
};

beforeEach(async () => {
  process.env.NODE_ENV = "development";
  process.env.DEV_ADMIN_EMAIL = "admin@test.local";
  process.env.DEV_ADMIN_PASSWORD_HASH = await hash("strong-admin-password");
  process.env.PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS = "true";
  process.env.PASSWORD_RECOVERY_MODE = "admin_assisted";
  process.env.PASSWORD_RESET_TEMP_TTL_MINUTES = "30";
  process.env.WEB_ORIGIN = "http://localhost:3000";
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("AuthService", () => {
  it("registers normal accounts only as member", async () => {
    const auth = new AuthService();
    const result = await auth.register({ email: "member@test.local", password: "strong-member-password", displayName: "Member Test" });
    expect(result.user.role).toBe("member");
    expect((await auth.userById(result.user.id)).walletUsd).toBe(0);
    expect(result.redirectTo).toBe("/dashboard");
  });

  it("resolves the configured fixed account as admin", async () => {
    const auth = new AuthService();
    const result = await auth.login({ email: "admin@test.local", password: "strong-admin-password" });
    expect("authState" in result).toBe(false);
    if ("authState" in result) throw new Error("Unexpected password reset session");
    expect(result.user.role).toBe("admin");
    expect(result.redirectTo).toBe("/admin/overview");
    expect(await auth.userById(result.user.id)).toMatchObject({ role: "admin", billingMode: "wallet", deviceLimit: 2, protected: true });
  });

  it("rejects a malformed configured password hash without leaking a server error", async () => {
    process.env.DEV_ADMIN_PASSWORD_HASH = "replace-with-argon2id-hash";
    await expect(new AuthService().login({ email: "admin@test.local", password: "strong-admin-password" }))
      .rejects.toThrow("Email atau password salah");
  });

  it("allows the separately configured bootstrap admin in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_STORAGE = "memory";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "owner@cliper.test";
    process.env.BOOTSTRAP_ADMIN_PASSWORD_HASH = await hash("production-admin-password");
    const result = await new AuthService().login({ email: "owner@cliper.test", password: "production-admin-password" });
    expect("authState" in result).toBe(false);
    if ("authState" in result) throw new Error("Unexpected password reset session");
    expect(result.mode).toBe("bootstrap-memory");
    expect(result.user.role).toBe("admin");
  });

  it("blocks member registration using the fixed admin email", async () => {
    await expect(new AuthService().register({ email: "admin@test.local", password: "strong-member-password", displayName: "Fake Admin" })).rejects.toThrow();
  });

  it("creates an investor session that routes to monitoring instead of member pages", async () => {
    const auth = new AuthService();
    await auth.createManagedAccount({ email: "investor@test.local", password: "strong-investor-password", displayName: "Investor Test", role: "investor" });
    const result = await auth.login({ email: "investor@test.local", password: "strong-investor-password" });
    expect("authState" in result).toBe(false);
    if ("authState" in result) throw new Error("Unexpected password reset session");
    expect(result.user.role).toBe("investor");
    expect(result.redirectTo).toBe("/admin/overview");
  });

  it("verifies and revokes an opaque development session", async () => {
    const auth = new AuthService();
    const login = await auth.register({ email: "member2@test.local", password: "strong-member-password", displayName: "Second Member" });
    expect((await auth.session(login.token)).role).toBe("member");
    await auth.logout(login.token);
    await expect(auth.session(login.token)).rejects.toThrow();
  });

  it("lets admin management update and suspend a member without exposing password hashes", async () => {
    const auth = new AuthService();
    const member = await auth.createMember({ email: "managed@test.local", password: "strong-member-password", displayName: "Managed Member" });
    expect(member).not.toHaveProperty("passwordHash");
    const updated = await auth.updateMember(member.id, { walletUsd: 5, status: "suspended" });
    expect(updated).toMatchObject({ billingMode: "wallet", walletUsd: 5, status: "suspended" });
    expect((await auth.listUsers()).find((item) => item.id === member.id)).toMatchObject({ billingMode: "wallet", protected: false });
    expect(await auth.deleteMember(member.id)).toMatchObject({ ok: true, status: "deleted" });
    expect((await auth.listUsers()).find((item) => item.id === member.id)).toMatchObject({ status: "deleted" });
  });

  it("does not issue an admin password reset for suspended or deleted members", async () => {
    const auth = new AuthService();
    const member = await auth.createMember({ email: "inactive-reset@test.local", password: "strong-member-password", displayName: "Inactive Reset" });
    await auth.updateMember(member.id, { status: "suspended" });
    await expect(auth.issueAdminTemporaryPassword(member.id)).rejects.toThrow("akun member yang aktif");
    await auth.deleteMember(member.id);
    await expect(auth.issueAdminTemporaryPassword(member.id)).rejects.toThrow("akun member yang aktif");
  });

  it("temporarily throttles an account after repeated invalid login attempts", async () => {
    const auth = new AuthService();
    for (let index = 0; index < 5; index += 1) {
      await expect(auth.login({ email: "missing@test.local", password: "wrong-password" })).rejects.toThrow("Email atau password salah");
    }
    await expect(auth.login({ email: "missing@test.local", password: "wrong-password" })).rejects.toThrow("Terlalu banyak");
  });

  it("forces an admin-assisted temporary-password recovery before normal access", async () => {
    const auth = new AuthService();
    const account = await auth.register({ email: "recover@test.local", password: "strong-member-password", displayName: "Recover Member" });
    const reset = await auth.issueAdminTemporaryPassword(account.user.id, "bootstrap-admin");
    expect(reset.temporaryPassword).toMatch(/^Clp-(?:[A-Za-z0-9]{4}-){2}[A-Za-z0-9]{4}$/);
    expect(reset.temporaryPassword).not.toContain("recover@test.local");
    await expect(auth.session(account.token)).rejects.toThrow("Session tidak valid");
    await expect(auth.login({ email: "recover@test.local", password: "strong-member-password" })).rejects.toThrow("Email atau password salah");
    const temporaryLogin = await auth.login({ email: "recover@test.local", password: reset.temporaryPassword });
    expect(temporaryLogin).toMatchObject({ authState: "PASSWORD_RESET_REQUIRED", redirectTo: "/change-password" });
    if (!("authState" in temporaryLogin)) throw new Error("Expected restricted password reset session");
    await expect(auth.passwordResetSession(temporaryLogin.resetToken)).resolves.toMatchObject({ authState: "PASSWORD_RESET_REQUIRED" });
    await expect(auth.completeTemporaryPasswordReset(temporaryLogin.resetToken, reset.temporaryPassword)).rejects.toThrow("berbeda dari password sementara");
    const completed = await auth.completeTemporaryPasswordReset(temporaryLogin.resetToken, "changed-member-password");
    expect(completed.redirectTo).toBe("/dashboard");
    await expect(auth.passwordResetSession(temporaryLogin.resetToken)).rejects.toThrow("Sesi reset password");
    await expect(auth.login({ email: "recover@test.local", password: reset.temporaryPassword })).rejects.toThrow("Email atau password salah");
    await expect(auth.login({ email: "recover@test.local", password: "strong-member-password" })).rejects.toThrow("Email atau password salah");
    const newLogin = await auth.login({ email: "recover@test.local", password: "changed-member-password" });
    expect(newLogin).toMatchObject({ user: { role: "member" } });
  });

  it("keeps the public recovery help response account-agnostic", async () => {
    const auth = new AuthService();
    const request = await auth.requestPasswordReset({ email: "unknown@test.local" });
    expect(request).toEqual({ ok: true, message: "Pemulihan password dilakukan melalui admin. Hubungi support untuk mendapatkan password sementara." });
  });

  it("invalidates the prior temporary password when an admin generates a new one", async () => {
    const auth = new AuthService();
    const account = await auth.register({ email: "replace-reset@test.local", password: "strong-member-password", displayName: "Replace Reset" });
    const first = await auth.issueAdminTemporaryPassword(account.user.id);
    const second = await auth.issueAdminTemporaryPassword(account.user.id);
    expect(second.temporaryPassword).not.toBe(first.temporaryPassword);
    await expect(auth.login({ email: "replace-reset@test.local", password: first.temporaryPassword })).rejects.toThrow("Email atau password salah");
    await expect(auth.login({ email: "replace-reset@test.local", password: second.temporaryPassword })).resolves.toMatchObject({ authState: "PASSWORD_RESET_REQUIRED" });
  });

  it("rejects an expired temporary password without restoring the prior password", async () => {
    const auth = new AuthService();
    const account = await auth.register({ email: "expired-reset@test.local", password: "strong-member-password", displayName: "Expired Reset" });
    const reset = await auth.issueAdminTemporaryPassword(account.user.id);
    const credentials = (auth as unknown as { passwordResetCredentials: Map<string, { expiresAt: number }> }).passwordResetCredentials;
    for (const credential of credentials.values()) credential.expiresAt = Date.now() - 1;
    await expect(auth.login({ email: "expired-reset@test.local", password: reset.temporaryPassword })).rejects.toThrow("Email atau password salah");
    await expect(auth.login({ email: "expired-reset@test.local", password: "strong-member-password" })).rejects.toThrow("Email atau password salah");
  });
});
