import { describe, expect, it } from "vitest";
import {
  productionBootstrapAdminFromEnv,
  productionBootstrapAdminSyncRequested,
} from "./sync-production-bootstrap-admin.js";

describe("productionBootstrapAdminFromEnv", () => {
  const hash = "$argon2id$v=19$m=19456,t=2,p=1$abc$def";

  it("accepts an Argon2id bootstrap admin in production", () => {
    expect(productionBootstrapAdminFromEnv({
      NODE_ENV: "production",
      BOOTSTRAP_ADMIN_EMAIL: "ADMIN@cliperaicloud.com",
      BOOTSTRAP_ADMIN_PASSWORD_HASH: hash,
      BOOTSTRAP_ADMIN_DEVICE_LIMIT: "7",
    })).toEqual({ email: "admin@cliperaicloud.com", passwordHash: hash, deviceLimit: 7 });
  });

  it("rejects local execution and weak configuration", () => {
    expect(() => productionBootstrapAdminFromEnv({ NODE_ENV: "development" })).toThrow("NODE_ENV=production");
    expect(() => productionBootstrapAdminFromEnv({
      NODE_ENV: "production",
      BOOTSTRAP_ADMIN_EMAIL: "admin@cliperaicloud.com",
      BOOTSTRAP_ADMIN_PASSWORD_HASH: "not-a-hash",
    })).toThrow("Argon2id");
  });

  it("requires two explicit flags before startup sync is allowed", () => {
    expect(productionBootstrapAdminSyncRequested({
      BOOTSTRAP_ADMIN_SYNC_ON_START: "true",
    })).toBe(false);
    expect(productionBootstrapAdminSyncRequested({
      BOOTSTRAP_ADMIN_SYNC_CONFIRMATION: "SYNC BOOTSTRAP ADMIN",
    })).toBe(false);
    expect(productionBootstrapAdminSyncRequested({
      BOOTSTRAP_ADMIN_SYNC_ON_START: "true",
      BOOTSTRAP_ADMIN_SYNC_CONFIRMATION: "SYNC BOOTSTRAP ADMIN",
    })).toBe(true);
  });
});
