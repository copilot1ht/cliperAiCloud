import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hash } from "@node-rs/argon2";
import { AuthService } from "./auth.service.js";

const original = {
  NODE_ENV: process.env.NODE_ENV,
  DEV_ADMIN_EMAIL: process.env.DEV_ADMIN_EMAIL,
  DEV_ADMIN_PASSWORD_HASH: process.env.DEV_ADMIN_PASSWORD_HASH,
  BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD_HASH: process.env.BOOTSTRAP_ADMIN_PASSWORD_HASH,
};

beforeEach(async () => {
  process.env.NODE_ENV = "development";
  process.env.DEV_ADMIN_EMAIL = "admin@test.local";
  process.env.DEV_ADMIN_PASSWORD_HASH = await hash("strong-admin-password");
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
    const result = await new AuthService().login({ email: "admin@test.local", password: "strong-admin-password" });
    expect(result.user.role).toBe("admin");
    expect(result.redirectTo).toBe("/admin/overview");
  });

  it("allows the separately configured bootstrap admin in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "owner@cliper.test";
    process.env.BOOTSTRAP_ADMIN_PASSWORD_HASH = await hash("production-admin-password");
    const result = await new AuthService().login({ email: "owner@cliper.test", password: "production-admin-password" });
    expect(result.mode).toBe("bootstrap-memory");
    expect(result.user.role).toBe("admin");
  });

  it("blocks member registration using the fixed admin email", async () => {
    await expect(new AuthService().register({ email: "admin@test.local", password: "strong-member-password", displayName: "Fake Admin" })).rejects.toThrow();
  });

  it("verifies and revokes an opaque development session", async () => {
    const auth = new AuthService();
    const login = await auth.register({ email: "member2@test.local", password: "strong-member-password", displayName: "Second Member" });
    expect(auth.session(login.token).role).toBe("member");
    auth.logout(login.token);
    expect(() => auth.session(login.token)).toThrow();
  });

  it("lets admin management update and suspend a member without exposing password hashes", async () => {
    const auth = new AuthService();
    const member = await auth.createMember({ email: "managed@test.local", password: "strong-member-password", displayName: "Managed Member", plan: "starter" });
    expect(member).not.toHaveProperty("passwordHash");
    const updated = auth.updateMember(member.id, { plan: "pro", credits: 5000, status: "suspended" });
    expect(updated).toMatchObject({ plan: "pro", credits: 5000, status: "suspended" });
    expect(auth.listUsers().find((item) => item.id === member.id)).toMatchObject({ plan: "pro", protected: false });
    expect(auth.deleteMember(member.id)).toEqual({ ok: true });
  });

  it("temporarily throttles an account after repeated invalid login attempts", async () => {
    const auth = new AuthService();
    for (let index = 0; index < 5; index += 1) {
      await expect(auth.login({ email: "missing@test.local", password: "wrong-password" })).rejects.toThrow("Email atau password salah");
    }
    await expect(auth.login({ email: "missing@test.local", password: "wrong-password" })).rejects.toThrow("Terlalu banyak");
  });
});
