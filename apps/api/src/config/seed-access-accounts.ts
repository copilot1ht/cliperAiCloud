import { Algorithm, hash } from "@node-rs/argon2";
import { loadWorkspaceEnv } from "./load-env.js";
import { DatabaseService } from "../database/database.service.js";
import { PlanCode, UserRole } from "../generated/prisma/client.js";

loadWorkspaceEnv();

interface SeedAccount {
  email: string;
  password: string;
  displayName: string;
  role: "super_admin" | "admin" | "investor" | "member";
  plan: "free" | "starter" | "pro" | "enterprise";
  deviceLimit: number;
  unlimitedCredits?: boolean;
  initialCredits?: number;
}

const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
};

function roleValue(role: SeedAccount["role"]): UserRole {
  if (role === "super_admin") return UserRole.SUPER_ADMIN;
  if (role === "admin") return UserRole.ADMIN;
  if (role === "investor") return UserRole.INVESTOR;
  return UserRole.MEMBER;
}

function planValue(plan: SeedAccount["plan"]): PlanCode {
  if (plan === "starter") return PlanCode.STARTER;
  if (plan === "pro") return PlanCode.PRO;
  if (plan === "enterprise") return PlanCode.ENTERPRISE;
  return PlanCode.FREE;
}

function accountsFromEnvironment(): SeedAccount[] {
  const raw = String(process.env.CLIPER_SEED_ACCOUNTS_JSON || "").trim();
  if (!raw) throw new Error("CLIPER_SEED_ACCOUNTS_JSON wajib diisi untuk proses seed satu kali.");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Data seed akun harus berupa array JSON.");
  return parsed.map((value, index) => {
    const account = value as Partial<SeedAccount>;
    const email = String(account.email || "").trim().toLowerCase();
    const password = String(account.password || "");
    const displayName = String(account.displayName || "").trim();
    const role = String(account.role || "member") as SeedAccount["role"];
    const plan = String(account.plan || "free") as SeedAccount["plan"];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Email akun #${index + 1} tidak valid.`);
    if (password.length < 10) throw new Error(`Password akun #${index + 1} minimal 10 karakter.`);
    if (displayName.length < 2 || displayName.length > 80) throw new Error(`Nama akun #${index + 1} tidak valid.`);
    if (!["super_admin", "admin", "investor", "member"].includes(role)) throw new Error(`Role akun #${index + 1} tidak valid.`);
    if (!["free", "starter", "pro", "enterprise"].includes(plan)) throw new Error(`Plan akun #${index + 1} tidak valid.`);
    return {
      email,
      password,
      displayName,
      role,
      plan,
      deviceLimit: Math.max(1, Math.min(50, Math.round(Number(account.deviceLimit || 1)))),
      unlimitedCredits: Boolean(account.unlimitedCredits),
      initialCredits: Math.max(0, Number(account.initialCredits || 0)),
    };
  });
}

async function main(): Promise<void> {
  const database = new DatabaseService();
  if (!database.configured()) throw new Error("DATABASE_URL belum dikonfigurasi.");
  const client = database.client();
  const accounts = accountsFromEnvironment();
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.email)) throw new Error(`Email duplikat pada seed: ${account.email}`);
    seen.add(account.email);
    const passwordHash = await hash(account.password, ARGON_OPTIONS);
    const role = roleValue(account.role);
    const planCode = planValue(account.plan);
    const user = await client.user.upsert({
      where: { email: account.email },
      create: {
        email: account.email,
        passwordHash,
        displayName: account.displayName,
        role,
        planCode,
        deviceLimit: account.deviceLimit,
        unlimitedCredits: Boolean(account.unlimitedCredits),
        isActive: true,
      },
      update: {
        passwordHash,
        passwordChangedAt: new Date(),
        displayName: account.displayName,
        role,
        planCode,
        deviceLimit: account.deviceLimit,
        unlimitedCredits: Boolean(account.unlimitedCredits),
        isActive: true,
      },
    });
    const initialMicro = BigInt(Math.round(Number(account.initialCredits || 0) * 1_000_000));
    await client.userCreditAccount.upsert({
      where: { userId: user.id },
      create: { userId: user.id, balanceMicro: initialMicro, lifetimeGrantedMicro: initialMicro },
      update: {},
    });
    await client.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    console.log(JSON.stringify({ email: account.email, role: account.role, plan: account.plan, unlimitedCredits: Boolean(account.unlimitedCredits), stored: true }));
  }
  await client.auditLog.create({
    data: { action: "accounts.secure_seed", entityType: "user", metadata: { accountCount: accounts.length, passwordStorage: "argon2id" } },
  });
  await database.onModuleDestroy();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seed akun gagal.");
  process.exitCode = 1;
});
