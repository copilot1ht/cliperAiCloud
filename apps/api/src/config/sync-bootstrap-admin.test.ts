import { describe, expect, it } from "vitest";
import { localBootstrapAdminFromEnv } from "./sync-bootstrap-admin.js";

describe("localBootstrapAdminFromEnv", () => {
  it("accepts a local Argon2id bootstrap account", () => {
    expect(localBootstrapAdminFromEnv({
      NODE_ENV: "development",
      DEV_ADMIN_EMAIL: "ADMIN@cliperaicloud.local",
      DEV_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
    })).toEqual({
      email: "admin@cliperaicloud.local",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
    });
  });

  it("rejects missing and non-Argon2id credentials", () => {
    expect(() => localBootstrapAdminFromEnv({ NODE_ENV: "development" })).toThrow("DEV_ADMIN_EMAIL");
    expect(() => localBootstrapAdminFromEnv({
      NODE_ENV: "development",
      DEV_ADMIN_EMAIL: "admin@cliperaicloud.local",
      DEV_ADMIN_PASSWORD_HASH: "not-a-hash",
    })).toThrow("Argon2id");
  });

  it("is not available in production", () => {
    expect(() => localBootstrapAdminFromEnv({
      NODE_ENV: "production",
      DEV_ADMIN_EMAIL: "admin@cliperaicloud.local",
      DEV_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
    })).toThrow("local development");
  });
});
