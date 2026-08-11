import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomInt } from "node:crypto";
import { DatabaseService } from "../database/database.service.js";

export const MICRO_USD = 1_000_000n;
const SETTINGS_ID = "default-wallet-payment";
const XENDIT_QRIS_MAX_IDR = 10_000_000;

export interface WalletPaymentSettings {
  source: "database" | "environment";
  walletCurrency: "USD";
  paymentCurrency: "IDR";
  minPurchaseUsd: string;
  maxPurchaseUsd: string;
  minPurchaseMicroUsd: bigint;
  maxPurchaseMicroUsd: bigint;
  usdToIdrRate: number;
  serviceFeeIdr: number;
  uniqueCodeEnabled: boolean;
  uniqueCodeMin: number;
  uniqueCodeMax: number;
  maxTotalPaymentIdr: number;
}

export interface WalletPaymentSettingsInput {
  minPurchaseUsd?: unknown;
  maxPurchaseUsd?: unknown;
  usdToIdrRate?: unknown;
  serviceFeeIdr?: unknown;
  uniqueCodeEnabled?: unknown;
  uniqueCodeMin?: unknown;
  uniqueCodeMax?: unknown;
}

export interface WalletPaymentQuote {
  purchaseMicroUsd: bigint;
  purchaseUsd: string;
  subtotalIdr: number;
  serviceFeeIdr: number;
  uniqueCodeIdr: number;
  totalPaymentIdr: number;
  usdToIdrRate: number;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestException(`${name} harus berupa bilangan antara ${minimum} dan ${maximum}.`);
  }
  return parsed;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function usdToMicro(value: unknown, field = "Nilai USD"): bigint {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new BadRequestException(`${field} harus berupa angka USD dengan maksimal 6 digit desimal.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const micro = BigInt(whole ?? "0") * MICRO_USD + BigInt((fraction ?? "").padEnd(6, "0"));
  if (micro <= 0n) throw new BadRequestException(`${field} harus lebih besar dari nol.`);
  return micro;
}

export function microToUsd(value: bigint | number | string): string {
  const micro = BigInt(value);
  const sign = micro < 0n ? "-" : "";
  const absolute = micro < 0n ? -micro : micro;
  return `${sign}${absolute / MICRO_USD}.${(absolute % MICRO_USD).toString().padStart(6, "0")}`;
}

function parseEnvironmentUsd(name: string, fallback: string): bigint {
  try {
    return usdToMicro(process.env[name] || fallback, name);
  } catch {
    return usdToMicro(fallback, name);
  }
}

function environmentSettings(): WalletPaymentSettings {
  const minPurchaseMicroUsd = parseEnvironmentUsd("PAYMENT_MIN_TOPUP_USD", "1");
  const maxPurchaseMicroUsd = parseEnvironmentUsd("PAYMENT_MAX_TOPUP_USD", "500");
  const usdToIdrRate = Number(process.env.PAYMENT_USD_TO_IDR_DISPLAY_RATE || 17_700);
  const serviceFeeIdr = Number(process.env.PAYMENT_SERVICE_FEE_IDR || 1_000);
  const uniqueCodeEnabled = bool(process.env.PAYMENT_UNIQUE_CODE_ENABLED, true);
  const uniqueCodeMin = Number(process.env.PAYMENT_UNIQUE_CODE_MIN || 99);
  const uniqueCodeMax = Number(process.env.PAYMENT_UNIQUE_CODE_MAX || 299);
  return normalize({
    source: "environment",
    minPurchaseMicroUsd,
    maxPurchaseMicroUsd,
    usdToIdrRate,
    serviceFeeIdr,
    uniqueCodeEnabled,
    uniqueCodeMin,
    uniqueCodeMax,
  });
}

function normalize(input: Omit<WalletPaymentSettings, "walletCurrency" | "paymentCurrency" | "minPurchaseUsd" | "maxPurchaseUsd" | "maxTotalPaymentIdr">): WalletPaymentSettings {
  const usdToIdrRate = integer(input.usdToIdrRate, "Kurs USD ke IDR", 1_000, 200_000);
  const serviceFeeIdr = integer(input.serviceFeeIdr, "Biaya layanan", 0, 1_000_000);
  const uniqueCodeMin = integer(input.uniqueCodeMin, "Kode unik minimum", 0, 9_999);
  const uniqueCodeMax = integer(input.uniqueCodeMax, "Kode unik maksimum", 0, 9_999);
  if (input.minPurchaseMicroUsd > input.maxPurchaseMicroUsd) {
    throw new BadRequestException("Minimum top-up USD tidak boleh melebihi maksimum.");
  }
  if (uniqueCodeMin > uniqueCodeMax) {
    throw new BadRequestException("Kode unik minimum tidak boleh melebihi maksimum.");
  }
  const maximumSubtotal = Number((input.maxPurchaseMicroUsd * BigInt(usdToIdrRate) + MICRO_USD - 1n) / MICRO_USD);
  const maximumTotal = maximumSubtotal + serviceFeeIdr + (input.uniqueCodeEnabled ? uniqueCodeMax : 0);
  if (!Number.isSafeInteger(maximumTotal) || maximumTotal > XENDIT_QRIS_MAX_IDR) {
    throw new BadRequestException(`Maksimum top-up melebihi batas QRIS ${XENDIT_QRIS_MAX_IDR.toLocaleString("id-ID")} IDR.`);
  }
  return {
    source: input.source,
    walletCurrency: "USD",
    paymentCurrency: "IDR",
    minPurchaseUsd: microToUsd(input.minPurchaseMicroUsd),
    maxPurchaseUsd: microToUsd(input.maxPurchaseMicroUsd),
    minPurchaseMicroUsd: input.minPurchaseMicroUsd,
    maxPurchaseMicroUsd: input.maxPurchaseMicroUsd,
    usdToIdrRate,
    serviceFeeIdr,
    uniqueCodeEnabled: input.uniqueCodeEnabled,
    uniqueCodeMin,
    uniqueCodeMax,
    maxTotalPaymentIdr: maximumTotal,
  };
}

@Injectable()
export class WalletPaymentSettingsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(): Promise<WalletPaymentSettings> {
    const fallback = environmentSettings();
    if (!this.database.configured()) return fallback;
    const stored = await this.database.client().walletPaymentSetting.findUnique({ where: { id: SETTINGS_ID } });
    if (!stored) return fallback;
    return normalize({
      source: "database",
      minPurchaseMicroUsd: stored.minPurchaseMicroUsd,
      maxPurchaseMicroUsd: stored.maxPurchaseMicroUsd,
      usdToIdrRate: stored.usdToIdrRate,
      serviceFeeIdr: stored.serviceFeeIdr,
      uniqueCodeEnabled: stored.uniqueCodeEnabled,
      uniqueCodeMin: stored.uniqueCodeMin,
      uniqueCodeMax: stored.uniqueCodeMax,
    });
  }

  async update(input: WalletPaymentSettingsInput): Promise<WalletPaymentSettings> {
    if (!this.database.configured()) {
      throw new ServiceUnavailableException("Pengaturan wallet USD membutuhkan PostgreSQL aktif.");
    }
    const current = await this.get();
    const next = normalize({
      source: "database",
      minPurchaseMicroUsd: input.minPurchaseUsd === undefined ? current.minPurchaseMicroUsd : usdToMicro(input.minPurchaseUsd, "Minimum top-up USD"),
      maxPurchaseMicroUsd: input.maxPurchaseUsd === undefined ? current.maxPurchaseMicroUsd : usdToMicro(input.maxPurchaseUsd, "Maksimum top-up USD"),
      usdToIdrRate: input.usdToIdrRate === undefined ? current.usdToIdrRate : Number(input.usdToIdrRate),
      serviceFeeIdr: input.serviceFeeIdr === undefined ? current.serviceFeeIdr : Number(input.serviceFeeIdr),
      uniqueCodeEnabled: input.uniqueCodeEnabled === undefined ? current.uniqueCodeEnabled : bool(input.uniqueCodeEnabled, current.uniqueCodeEnabled),
      uniqueCodeMin: input.uniqueCodeMin === undefined ? current.uniqueCodeMin : Number(input.uniqueCodeMin),
      uniqueCodeMax: input.uniqueCodeMax === undefined ? current.uniqueCodeMax : Number(input.uniqueCodeMax),
    });
    await this.database.client().walletPaymentSetting.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        walletCurrency: "USD",
        paymentCurrency: "IDR",
        minPurchaseMicroUsd: next.minPurchaseMicroUsd,
        maxPurchaseMicroUsd: next.maxPurchaseMicroUsd,
        usdToIdrRate: next.usdToIdrRate,
        serviceFeeIdr: next.serviceFeeIdr,
        uniqueCodeEnabled: next.uniqueCodeEnabled,
        uniqueCodeMin: next.uniqueCodeMin,
        uniqueCodeMax: next.uniqueCodeMax,
      },
      update: {
        walletCurrency: "USD",
        paymentCurrency: "IDR",
        minPurchaseMicroUsd: next.minPurchaseMicroUsd,
        maxPurchaseMicroUsd: next.maxPurchaseMicroUsd,
        usdToIdrRate: next.usdToIdrRate,
        serviceFeeIdr: next.serviceFeeIdr,
        uniqueCodeEnabled: next.uniqueCodeEnabled,
        uniqueCodeMin: next.uniqueCodeMin,
        uniqueCodeMax: next.uniqueCodeMax,
      },
    });
    return next;
  }

  quote(purchaseMicroUsd: bigint, settings: WalletPaymentSettings): WalletPaymentQuote {
    if (purchaseMicroUsd < settings.minPurchaseMicroUsd || purchaseMicroUsd > settings.maxPurchaseMicroUsd) {
      throw new BadRequestException(`Top-up harus antara US$${settings.minPurchaseUsd} dan US$${settings.maxPurchaseUsd}.`);
    }
    const subtotalIdr = Number((purchaseMicroUsd * BigInt(settings.usdToIdrRate) + MICRO_USD - 1n) / MICRO_USD);
    const uniqueCodeIdr = settings.uniqueCodeEnabled
      ? randomInt(settings.uniqueCodeMin, settings.uniqueCodeMax + 1)
      : 0;
    const totalPaymentIdr = subtotalIdr + settings.serviceFeeIdr + uniqueCodeIdr;
    if (totalPaymentIdr > XENDIT_QRIS_MAX_IDR) {
      throw new BadRequestException("Total QRIS melebihi batas payment gateway.");
    }
    return {
      purchaseMicroUsd,
      purchaseUsd: microToUsd(purchaseMicroUsd),
      subtotalIdr,
      serviceFeeIdr: settings.serviceFeeIdr,
      uniqueCodeIdr,
      totalPaymentIdr,
      usdToIdrRate: settings.usdToIdrRate,
    };
  }
}
