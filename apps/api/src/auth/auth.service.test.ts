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
  PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS: process.env.PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS,
  WEB_ORIGIN: process.env.WEB_ORIGIN,
};

beforeEach(async () => {
  process.env.NODE_ENV = "development";
  process.env.DEV_ADMIN_EMAIL = "admin@test.local";
  process.env.DEV_ADMIN_PASSWORD_HASH = await hash("strong-admin-password");
  process.env.PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS = "true";
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
    const result = await new AuthService().register({ email: "member@test.local", password: "strong-member-password", displayName: "Member Test" });
    expect(result.user.role).toBe("member");
    expect(result.redirectTo).toBe("/dashboard");
  });

  it("resolves the configured fixed account as admin", async () => {
    const auth = new AuthService();
    const result = await auth.login({ email: "admin@test.local", password: "strong-admin-password" });
    expect(result.user.role).toBe("admin");
    expect(result.redirectTo).toBe("/admin/overview");
    expect(await auth.userById(result.user.id)).toMatchObject({ role: "admin", plan: "enterprise", deviceLimit: 2, protected: true });
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
    const member = await auth.createMember({ email: "managed@test.local", password: "strong-member-password", displayName: "Managed Member", plan: "starter" });
    expect(member).not.toHaveProperty("passwordHash");
    const updated = await auth.updateMember(member.id, { plan: "pro", credits: 5000, status: "suspended" });
    expect(updated).toMatchObject({ plan: "pro", credits: 5000, status: "suspended" });
    expect((await auth.listUsers()).find((item) => item.id === member.id)).toMatchObject({ plan: "pro", protected: false });
    expect(await auth.deleteMember(member.id)).toEqual({ ok: true });
  });

  it("temporarily throttles an account after repeated invalid login attempts", async () => {
    const auth = new AuthService();
    for (let index = 0; index < 5; index += 1) {
      await expect(auth.login({ email: "missing@test.local", password: "wrong-password" })).rejects.toThrow("Email atau password salah");
    }
    await expect(auth.login({ email: "missing@test.local", password: "wrong-password" })).rejects.toThrow("Terlalu banyak");
  });

  it("uses a one-time recovery token and revokes existing sessions", async () => {
    const auth = new AuthService();
    const account = await auth.register({ email: "recover@test.local", password: "strong-member-password", displayName: "Recover Member" });
    const request = await auth.requestPasswordReset({ email: "recover@test.local" });
    expect(request.resetToken).toBeTruthy();
    await auth.confirmPasswordReset({ token: request.resetToken, password: "changed-member-password" });
    await expect(auth.session(account.token)).rejects.toThrow("Session tidak valid");
    await expect(auth.confirmPasswordReset({ token: request.resetToken, password: "another-password" })).rejects.toThrow("Tautan pemulihan");
    await expect(auth.login({ email: "recover@test.local", password: "changed-member-password" })).resolves.toMatchObject({ user: { role: "member" } });
  });

  it("does not reveal whether an unknown email owns an account", async () => {
    const auth = new AuthService();
    const request = await auth.requestPasswordReset({ email: "unknown@test.local" });
    expect(request).toEqual({ ok: true, message: "Jika akun terdaftar, tautan pemulihan telah dikirim ke email Anda." });
  });
});
