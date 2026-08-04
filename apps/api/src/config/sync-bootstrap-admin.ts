import { loadWorkspaceEnv } from "./load-env.js";
import { DatabaseService } from "../database/database.service.js";
import { PlanCode, UserRole } from "../generated/prisma/client.js";

export interface LocalBootstrapAdmin {
  email: string;
  passwordHash: string;
}

export function localBootstrapAdminFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LocalBootstrapAdmin {
  const mode = String(env.NODE_ENV || "development").trim().toLowerCase();
  if (mode === "production") {
    throw new Error("Sinkronisasi bootstrap admin hanya untuk environment local development.");
  }

  const email = String(env.DEV_ADMIN_EMAIL || "").trim().toLowerCase();
  const passwordHash = String(env.DEV_ADMIN_PASSWORD_HASH || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("DEV_ADMIN_EMAIL lokal tidak valid.");
  }
  if (!passwordHash.startsWith("$argon2id$")) {
    throw new Error("DEV_ADMIN_PASSWORD_HASH harus berupa hash Argon2id.");
  }
  return { email, passwordHash };
}

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const admin = localBootstrapAdminFromEnv();
  const database = new DatabaseService();
  if (!database.configured()) {
    throw new Error("DATABASE_URL belum dikonfigurasi untuk sinkronisasi admin lokal.");
  }

  const client = database.client();
  const user = await client.user.upsert({
    where: { email: admin.email },
    create: {
      email: admin.email,
      passwordHash: admin.passwordHash,
      displayName: "Cliper Local Admin",
      role: UserRole.SUPER_ADMIN,
      planCode: PlanCode.ENTERPRISE,
      deviceLimit: 5,
      unlimitedCredits: true,
      isActive: true,
    },
    update: {
      passwordHash: admin.passwordHash,
      passwordChangedAt: new Date(),
      displayName: "Cliper Local Admin",
      role: UserRole.SUPER_ADMIN,
      planCode: PlanCode.ENTERPRISE,
      deviceLimit: 5,
      unlimitedCredits: true,
      isActive: true,
    },
  });

  await client.userCreditAccount.upsert({
    where: { userId: user.id },
    create: { userId: user.id, balanceMicro: 0n, lifetimeGrantedMicro: 0n },
    update: {},
  });
  await client.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await client.auditLog.create({
    data: {
      action: "accounts.local_bootstrap_sync",
      entityType: "user",
      entityId: user.id,
      metadata: { role: "super_admin", passwordStorage: "argon2id" },
    },
  });
  await database.onModuleDestroy();
  process.stdout.write(JSON.stringify({ email: admin.email, role: "super_admin", synced: true }));
}

if (process.argv[1] && process.argv[1].includes("sync-bootstrap-admin")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Sinkronisasi admin lokal gagal.");
    process.exitCode = 1;
  });
}
