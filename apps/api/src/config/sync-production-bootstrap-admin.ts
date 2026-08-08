import { DatabaseService } from "../database/database.service.js";
import { PlanCode, UserRole } from "../generated/prisma/client.js";
import { loadWorkspaceEnv } from "./load-env.js";

export interface ProductionBootstrapAdmin {
  email: string;
  passwordHash: string;
  deviceLimit: number;
}

export function productionBootstrapAdminFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProductionBootstrapAdmin {
  const mode = String(env.NODE_ENV || "").trim().toLowerCase();
  if (mode !== "production") {
    throw new Error("Sinkronisasi ini hanya boleh dijalankan dengan NODE_ENV=production.");
  }

  const email = String(env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  const passwordHash = String(env.BOOTSTRAP_ADMIN_PASSWORD_HASH || "").trim();
  const rawLimit = Number(env.BOOTSTRAP_ADMIN_DEVICE_LIMIT || 5);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL production tidak valid.");
  }
  if (!passwordHash.startsWith("$argon2id$")) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD_HASH harus berupa hash Argon2id.");
  }
  return {
    email,
    passwordHash,
    deviceLimit: Number.isSafeInteger(rawLimit) && rawLimit > 0 ? rawLimit : 5,
  };
}

async function main(): Promise<void> {
  loadWorkspaceEnv();
  if (process.argv[2] !== "--confirm-live-reset") {
    throw new Error("Tambahkan --confirm-live-reset untuk mencabut sesi dan menyetel ulang akun bootstrap production.");
  }

  const admin = productionBootstrapAdminFromEnv();
  const database = new DatabaseService();
  if (!database.configured()) {
    throw new Error("DATABASE_URL belum dikonfigurasi untuk sinkronisasi admin production.");
  }

  const client = database.client();
  const now = new Date();
  const user = await client.user.upsert({
    where: { email: admin.email },
    create: {
      email: admin.email,
      passwordHash: admin.passwordHash,
      displayName: "Cliper Administrator",
      role: UserRole.SUPER_ADMIN,
      planCode: PlanCode.ENTERPRISE,
      deviceLimit: admin.deviceLimit,
      unlimitedCredits: true,
      isActive: true,
      creditAccount: { create: { balanceMicro: 0n, lifetimeGrantedMicro: 0n } },
    },
    update: {
      passwordHash: admin.passwordHash,
      passwordChangedAt: now,
      displayName: "Cliper Administrator",
      role: UserRole.SUPER_ADMIN,
      planCode: PlanCode.ENTERPRISE,
      deviceLimit: admin.deviceLimit,
      unlimitedCredits: true,
      isActive: true,
    },
  });

  await client.userCreditAccount.upsert({
    where: { userId: user.id },
    create: { userId: user.id, balanceMicro: 0n, lifetimeGrantedMicro: 0n },
    update: {},
  });
  await client.$transaction([
    client.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } }),
    client.desktopSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } }),
    client.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    client.auditLog.create({
      data: {
        actorId: user.id,
        action: "accounts.production_bootstrap_sync",
        entityType: "user",
        entityId: user.id,
        metadata: { role: "super_admin", passwordStorage: "argon2id", sessionsRevoked: true },
      },
    }),
  ]);
  await database.onModuleDestroy();
  process.stdout.write(JSON.stringify({ email: admin.email, role: "super_admin", synced: true, sessionsRevoked: true }));
}

if (process.argv[1] && process.argv[1].includes("sync-production-bootstrap-admin")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Sinkronisasi admin production gagal.");
    process.exitCode = 1;
  });
}
