import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { AdminStoreService } from "./admin-store.service.js";

const BACKUP_FORMAT = "cliper-admin-backup";
const BACKUP_VERSION = 1;
const BIGINT_MARKER = "__cliper_backup_bigint__";
const RESTORE_CONFIRMATION = "RESTORE ALL DATA";

const EXPORT_TABLES = [
  "plan",
  "user",
  "subscription",
  "apiKey",
  "userCreditAccount",
  "aiProvider",
  "providerPrice",
  "pricingPolicy",
  "routingRule",
  "license",
  "device",
  "analysisJob",
  "aiUsage",
  "paymentTransaction",
  "invoice",
  "invoiceItem",
  "creditLedger",
  "paymentLog",
  "auditLog",
] as const;

type BackupTable = typeof EXPORT_TABLES[number];
type BackupRow = Record<string, unknown>;
type BackupTables = Record<BackupTable, BackupRow[]>;

interface BackupDelegate {
  findMany: () => Promise<BackupRow[]>;
  createMany: (input: { data: BackupRow[]; skipDuplicates?: boolean }) => Promise<unknown>;
  deleteMany: () => Promise<unknown>;
}

interface BackupPrisma {
  $transaction: (callback: (client: BackupPrisma) => Promise<void>) => Promise<void>;
  [delegate: string]: unknown;
}

interface BackupSnapshot {
  application: "Cliper AI Cloud";
  formatVersion: number;
  createdAt: string;
  source: { environment: string; databaseSchema: string };
  exclusions: string[];
  tables: BackupTables;
}

export interface EncryptedBackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  encryption: {
    algorithm: "AES-256-GCM";
    kdf: "scrypt";
    salt: string;
    iv: string;
    tag: string;
  };
  manifest: {
    application: "Cliper AI Cloud";
    sourceEnvironment: string;
    tableCounts: Record<BackupTable, number>;
    exclusions: string[];
  };
  ciphertext: string;
}

const excludedData = [
  "Browser sessions and refresh-token hashes",
  "Password-reset tokens",
  "Desktop sessions, signing secrets, and request nonces",
  "Railway, Midtrans, Resend, and provider environment secrets",
  "Operational provider/system logs",
];

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toBase64(value: Buffer): string {
  return value.toString("base64");
}

function fromBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new BadRequestException(`Arsip backup memiliki ${label} yang tidak valid.`);
  }
  const parsed = Buffer.from(value, "base64");
  if (!parsed.length) throw new BadRequestException(`Arsip backup memiliki ${label} kosong.`);
  return parsed;
}

function stringifySnapshot(snapshot: BackupSnapshot): string {
  return JSON.stringify(snapshot, (_key, value: unknown) => (
    typeof value === "bigint" ? { [BIGINT_MARKER]: value.toString() } : value
  ));
}

function parseSnapshot(serialized: string): BackupSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized, (_key, value: unknown) => {
      if (isRecord(value) && Object.keys(value).length === 1 && typeof value[BIGINT_MARKER] === "string") {
        return BigInt(value[BIGINT_MARKER]);
      }
      return value;
    });
  } catch {
    throw new BadRequestException("Isi arsip backup tidak dapat dibaca.");
  }
  if (!isRecord(parsed) || parsed.application !== "Cliper AI Cloud" || parsed.formatVersion !== BACKUP_VERSION || !isRecord(parsed.tables)) {
    throw new BadRequestException("Arsip backup bukan format Cliper AI Cloud yang didukung.");
  }
  const tables = {} as BackupTables;
  for (const table of EXPORT_TABLES) {
    const rows = parsed.tables[table];
    if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
      throw new BadRequestException(`Tabel backup ${table} tidak valid.`);
    }
    tables[table] = rows as BackupRow[];
  }
  return {
    application: "Cliper AI Cloud",
    formatVersion: BACKUP_VERSION,
    createdAt: String(parsed.createdAt || ""),
    source: isRecord(parsed.source)
      ? { environment: String(parsed.source.environment || "unknown"), databaseSchema: String(parsed.source.databaseSchema || "public") }
      : { environment: "unknown", databaseSchema: "public" },
    exclusions: Array.isArray(parsed.exclusions) ? parsed.exclusions.map(String) : [],
    tables,
  };
}

function createEnvelope(snapshot: BackupSnapshot, passphrase: string): EncryptedBackupEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(stringifySnapshot(snapshot), "utf8"), cipher.final()]);
  const tableCounts = Object.fromEntries(EXPORT_TABLES.map((table) => [table, snapshot.tables[table].length])) as Record<BackupTable, number>;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: snapshot.createdAt,
    encryption: { algorithm: "AES-256-GCM", kdf: "scrypt", salt: toBase64(salt), iv: toBase64(iv), tag: toBase64(cipher.getAuthTag()) },
    manifest: { application: "Cliper AI Cloud", sourceEnvironment: snapshot.source.environment, tableCounts, exclusions: snapshot.exclusions },
    ciphertext: toBase64(ciphertext),
  };
}

function publicOrigin(value: string | undefined, fallback: string): string {
  const candidate = String(value || "").split(",")[0]?.trim() || fallback;
  try {
    return new URL(candidate).origin;
  } catch {
    return fallback;
  }
}

export function openEncryptedBackup(input: unknown, passphrase: string): BackupSnapshot {
  if (!isRecord(input) || input.format !== BACKUP_FORMAT || input.version !== BACKUP_VERSION || !isRecord(input.encryption)) {
    throw new BadRequestException("Pilih file backup Cliper AI Cloud yang valid.");
  }
  const encryption = input.encryption;
  if (encryption.algorithm !== "AES-256-GCM" || encryption.kdf !== "scrypt") {
    throw new BadRequestException("Algoritma enkripsi arsip backup tidak didukung.");
  }
  const salt = fromBase64(encryption.salt, "salt");
  const iv = fromBase64(encryption.iv, "iv");
  const tag = fromBase64(encryption.tag, "authentication tag");
  const ciphertext = fromBase64(input.ciphertext, "ciphertext");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new BadRequestException("Parameter enkripsi arsip backup tidak valid.");
  }
  try {
    const key = scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return parseSnapshot(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException("Passphrase salah atau file backup telah diubah.");
  }
}

function delegate(client: BackupPrisma, table: BackupTable): BackupDelegate {
  const value = client[table];
  if (!isRecord(value) || typeof value.findMany !== "function" || typeof value.createMany !== "function" || typeof value.deleteMany !== "function") {
    throw new ServiceUnavailableException(`Tabel backup ${table} tidak tersedia pada database saat ini.`);
  }
  return value as unknown as BackupDelegate;
}

@Injectable()
export class BackupService {
  constructor(
    private readonly database: DatabaseService,
    private readonly adminStore: AdminStoreService,
  ) {}

  async status() {
    const databaseReachable = this.database.configured() && await this.database.ping();
    const webOrigin = publicOrigin(process.env.WEB_ORIGIN, "https://www.cliperaicloud.online");
    const apiOrigin = publicOrigin(process.env.API_PUBLIC_URL, "https://api.cliperaicloud.online");
    const paymentProvider = String(process.env.PAYMENT_PROVIDER || "sandbox").trim().toLowerCase();
    const production = String(process.env.MIDTRANS_IS_PRODUCTION || "false").trim().toLowerCase() === "true";
    return {
      ready: databaseReachable,
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      maxArchiveBytes: boundedInteger(process.env.BACKUP_MAX_BYTES, 12 * 1024 * 1024, 1 * 1024 * 1024, 64 * 1024 * 1024),
      maxRows: boundedInteger(process.env.BACKUP_MAX_ROWS, 100_000, 1_000, 1_000_000),
      exclusions: excludedData,
      requirements: [
        "Restore harus memakai passphrase backup yang sama.",
        "LICENSE_KEY_PEPPER yang sama diperlukan agar clip_sk yang aktif tetap dapat diverifikasi.",
        "PROVIDER_ENCRYPTION_KEY yang sama diperlukan agar konfigurasi provider lama dapat dibaca.",
        "Midtrans, Railway, Resend, dan secret environment dikonfigurasi ulang di akun Railway tujuan.",
      ],
      paymentSetup: {
        provider: paymentProvider,
        environment: paymentProvider === "midtrans" ? (production ? "production" : "sandbox") : "not-configured",
        finishRedirectUrl: `${webOrigin}/billing`,
        notificationUrl: `${apiOrigin}/api/payments/webhook/midtrans`,
        biSnap: "Tidak dikonfigurasi. Cliper memakai Snap/Core API QRIS; jangan mengisi URL BI-SNAP tanpa integrasi BI-SNAP khusus.",
      },
    };
  }

  async exportEncrypted(passphraseInput: unknown, actorId?: string) {
    const passphrase = this.requirePassphrase(passphraseInput);
    const snapshot = await this.snapshot();
    const envelope = createEnvelope(snapshot, passphrase);
    const serialized = JSON.stringify(envelope);
    const maximum = boundedInteger(process.env.BACKUP_MAX_BYTES, 12 * 1024 * 1024, 1 * 1024 * 1024, 64 * 1024 * 1024);
    if (Buffer.byteLength(serialized, "utf8") > maximum) {
      throw new BadRequestException(`Backup melebihi batas ${(maximum / 1024 / 1024).toFixed(0)} MB. Kurangi riwayat usage atau naikkan BACKUP_MAX_BYTES secara sadar.`);
    }
    await this.writeAudit("backup.exported", actorId, { tableCounts: envelope.manifest.tableCounts, bytes: Buffer.byteLength(serialized, "utf8") });
    return { fileName: `cliper-cloud-backup-${snapshot.createdAt.replace(/[:.]/g, "-")}.json`, archive: envelope };
  }

  inspect(input: { archive?: unknown; passphrase?: unknown }) {
    const snapshot = openEncryptedBackup(input.archive, this.requirePassphrase(input.passphrase));
    const tableCounts = Object.fromEntries(EXPORT_TABLES.map((table) => [table, snapshot.tables[table].length])) as Record<BackupTable, number>;
    const totalRows = Object.values(tableCounts).reduce((sum, count) => sum + count, 0);
    this.assertRowCount(totalRows);
    return {
      source: snapshot.source,
      createdAt: snapshot.createdAt,
      tableCounts,
      totalRows,
      exclusions: snapshot.exclusions,
      requiresConfirmation: RESTORE_CONFIRMATION,
      effect: "Restoring replaces current control-plane records and revokes all active browser/desktop sessions.",
    };
  }

  async restore(input: { archive?: unknown; passphrase?: unknown; confirmation?: unknown }, actorId?: string) {
    if (String(input.confirmation || "").trim() !== RESTORE_CONFIRMATION) {
      throw new BadRequestException(`Ketik ${RESTORE_CONFIRMATION} untuk mengizinkan restore penuh.`);
    }
    this.assertReady();
    const snapshot = openEncryptedBackup(input.archive, this.requirePassphrase(input.passphrase));
    const totalRows = EXPORT_TABLES.reduce((sum, table) => sum + snapshot.tables[table].length, 0);
    this.assertRowCount(totalRows);
    const client = this.database.client() as unknown as BackupPrisma;
    await client.$transaction(async (transaction) => {
      for (const table of [
        "paymentLog", "invoiceItem", "creditLedger", "aiUsage", "analysisJob", "invoice", "paymentTransaction", "device", "license", "userCreditAccount", "subscription", "apiKey", "routingRule", "pricingPolicy", "providerPrice", "aiProvider", "auditLog", "plan", "user",
      ] as BackupTable[]) {
        await delegate(transaction, table).deleteMany();
      }
      for (const table of EXPORT_TABLES) {
        const rows = snapshot.tables[table];
        if (rows.length) await delegate(transaction, table).createMany({ data: rows });
      }
    });
    await this.adminStore.reloadFromDatabase();
    await this.writeAudit("backup.restored", actorId, { source: snapshot.source, createdAt: snapshot.createdAt, totalRows });
    return { restored: true, totalRows, requiresReauthentication: true };
  }

  private async snapshot(): Promise<BackupSnapshot> {
    this.assertReady();
    const client = this.database.client() as unknown as BackupPrisma;
    const entries = await Promise.all(EXPORT_TABLES.map(async (table) => [table, await delegate(client, table).findMany()] as const));
    const tables = Object.fromEntries(entries) as BackupTables;
    this.assertRowCount(EXPORT_TABLES.reduce((sum, table) => sum + tables[table].length, 0));
    return {
      application: "Cliper AI Cloud",
      formatVersion: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      source: { environment: String(process.env.NODE_ENV || "development"), databaseSchema: String(process.env.DATABASE_SCHEMA || "public") },
      exclusions: excludedData,
      tables,
    };
  }

  private requirePassphrase(value: unknown): string {
    const passphrase = String(value || "");
    if (passphrase.length < 14 || passphrase.length > 256) {
      throw new BadRequestException("Passphrase backup harus terdiri dari 14 sampai 256 karakter.");
    }
    return passphrase;
  }

  private assertReady(): void {
    if (!this.database.configured()) throw new ServiceUnavailableException("Backup memerlukan PostgreSQL yang aktif. Memory mode tidak dapat dibackup.");
  }

  private assertRowCount(totalRows: number): void {
    const maximum = boundedInteger(process.env.BACKUP_MAX_ROWS, 100_000, 1_000, 1_000_000);
    if (totalRows > maximum) throw new BadRequestException(`Backup berisi ${totalRows.toLocaleString("id-ID")} baris, melampaui BACKUP_MAX_ROWS (${maximum.toLocaleString("id-ID")}).`);
  }

  private async writeAudit(action: string, actorId: string | undefined, metadata: Record<string, unknown>): Promise<void> {
    if (!this.database.configured()) return;
    const actorExists = actorId ? await this.database.client().user.count({ where: { id: actorId } }) > 0 : false;
    await this.database.client().auditLog.create({
      data: {
        action,
        entityType: "backup",
        entityId: null,
        actorId: actorExists ? actorId : null,
        metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
      },
    });
  }
}

export const backupRestoreConfirmation = RESTORE_CONFIRMATION;
