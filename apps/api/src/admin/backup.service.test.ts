import { describe, expect, it, vi } from "vitest";
import { BackupService, openEncryptedBackup } from "./backup.service.js";

const tableNames = [
  "plan", "user", "subscription", "apiKey", "userCreditAccount", "aiProvider", "providerPrice",
  "pricingPolicy", "routingRule", "license", "device", "analysisJob", "aiUsage", "paymentTransaction",
  "invoice", "invoiceItem", "creditLedger", "paymentLog", "auditLog",
];

function createService() {
  const client: Record<string, any> = {};
  for (const table of tableNames) {
    client[table] = { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn(), deleteMany: vi.fn() };
  }
  client.user.findMany = vi.fn().mockResolvedValue([{ id: "admin-1", email: "admin@cliperaicloud.test", balance: 5n }]);
  client.user.count = vi.fn().mockResolvedValue(1);
  client.auditLog.create = vi.fn().mockResolvedValue({ id: "audit-1" });
  const database = { configured: () => true, ping: vi.fn().mockResolvedValue(true), client: () => client };
  const adminStore = { reloadFromDatabase: vi.fn().mockResolvedValue(undefined) };
  return new BackupService(database as any, adminStore as any);
}

describe("BackupService", () => {
  it("creates a portable encrypted archive and rejects a wrong passphrase", async () => {
    const service = createService();
    const passphrase = "backup passphrase 2026";
    const result = await service.exportEncrypted(passphrase, "admin-1");
    const snapshot = openEncryptedBackup(result.archive, passphrase);

    expect(snapshot.application).toBe("Cliper AI Cloud");
    expect(snapshot.tables.user[0]).toMatchObject({ id: "admin-1", balance: 5n });
    expect(() => openEncryptedBackup(result.archive, "wrong passphrase 2026")).toThrow("Passphrase salah");
  });
});
