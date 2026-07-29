import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface UsageCostInput {
  providerCostMicroUsd: bigint;
  computeCostMicroUsd?: bigint;
  paymentFeeBps?: number;
  reserveBps?: number;
  minimumChargeMicroUsd?: bigint;
  markupBps: number;
  minimumMarginBps?: number;
  microUsdPerCredit: bigint;
}

export interface UsageCostQuote {
  providerCostMicroUsd: bigint;
  computeCostMicroUsd: bigint;
  overheadCostMicroUsd: bigint;
  serviceCostMicroUsd: bigint;
  userChargeMicroUsd: bigint;
  grossProfitMicroUsd: bigint;
  creditChargeMicro: bigint;
  markupBps: number;
  grossMarginBps: number;
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new Error("Divisor harus lebih besar dari nol.");
  return (value + divisor - 1n) / divisor;
}

function bpsCharge(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 100_000) throw new Error("Basis points tidak valid.");
  return ceilDivide(value * BigInt(bps), 10_000n);
}

function requiredMarkupBps(minimumMarginBps: number): number {
  if (!Number.isInteger(minimumMarginBps) || minimumMarginBps < 0 || minimumMarginBps >= 10_000) {
    throw new Error("Minimum gross margin tidak valid.");
  }
  if (minimumMarginBps === 0) return 0;
  return Math.ceil((minimumMarginBps * 10_000) / (10_000 - minimumMarginBps));
}

export function quoteUsageCost(input: UsageCostInput): UsageCostQuote {
  if (input.providerCostMicroUsd < 0n || (input.computeCostMicroUsd ?? 0n) < 0n || (input.minimumChargeMicroUsd ?? 0n) < 0n) throw new Error("Cost tidak boleh negatif.");
  if (input.microUsdPerCredit <= 0n) throw new Error("Nilai credit harus lebih besar dari nol.");
  const computeCost = input.computeCostMicroUsd ?? 0n;
  const baseCost = input.providerCostMicroUsd + computeCost;
  const overhead = bpsCharge(baseCost, (input.paymentFeeBps ?? 0) + (input.reserveBps ?? 0));
  const serviceCost = [baseCost + overhead, input.minimumChargeMicroUsd ?? 0n].reduce((largest, value) => value > largest ? value : largest, 0n);
  const minimumMarginBps = input.minimumMarginBps ?? 0;
  const markupBps = Math.max(input.markupBps, requiredMarkupBps(minimumMarginBps));
  const userCharge = serviceCost + bpsCharge(serviceCost, markupBps);
  const creditChargeMicro = ceilDivide(userCharge * 1_000_000n, input.microUsdPerCredit);
  const grossProfit = userCharge - serviceCost;
  const grossMarginBps = userCharge > 0n ? Number(grossProfit * 10_000n / userCharge) : 0;
  return {
    providerCostMicroUsd: input.providerCostMicroUsd,
    computeCostMicroUsd: computeCost,
    overheadCostMicroUsd: overhead,
    serviceCostMicroUsd: serviceCost,
    userChargeMicroUsd: userCharge,
    grossProfitMicroUsd: grossProfit,
    creditChargeMicro,
    markupBps,
    grossMarginBps,
  };
}

export type ClipQualityTier = "rejected" | "optional" | "good" | "premium";
export type JobBudgetStatus = "target" | "warning" | "hard-limit";

export interface ClipJobPricingPolicy {
  creditValueIdr: number;
  minimumGrossMarginBps: number;
  targetGrossMarginBps: number;
  baseAnalysisCredits: number;
  optionalClipCredits: number;
  goodClipCredits: number;
  premiumClipCredits: number;
  optionalScoreMin: number;
  goodScoreMin: number;
  premiumScoreMin: number;
  minimumJobCredits: number;
  maximumJobCredits: number;
  infrastructureFeeIdr: number;
  safetyBufferBps: number;
  retryAllowanceBps: number;
  paymentFeeAllocationBps: number;
  targetProviderCostIdr: number;
  warningProviderCostIdr: number;
  hardProviderCostIdr: number;
  lowBalanceWarningCredits: number;
}

export interface ClipJobPricingInput {
  providerCostIdr: number;
  clipScores: number[];
  usableResult?: boolean;
  cached?: boolean;
}

export interface ClipJobPricingQuote {
  providerCostIdr: number;
  internalCostIdr: number;
  protectedPriceIdr: number;
  qualityPriceCredits: number;
  protectedPriceCredits: number;
  finalChargeCredits: number;
  reservationCredits: number;
  grossProfitIdr: number;
  grossMarginBps: number;
  capApplied: boolean;
  capSafe: boolean;
  budgetStatus: JobBudgetStatus;
  acceptedClipCount: number;
  rejectedClipCount: number;
  tierCounts: Record<ClipQualityTier, number>;
  tierCharges: Record<Exclude<ClipQualityTier, "rejected">, number>;
}

export interface ClipJobPricingValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  hardLimitProtectedCredits: number;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} harus berupa integer minimal ${minimum}.`);
  }
  return parsed;
}

function safeBps(value: unknown, label: string, maximum = 9_500): number {
  const parsed = safeInteger(value, label);
  if (parsed > maximum) throw new Error(`${label} melebihi batas aman.`);
  return parsed;
}

function ceilBps(value: number, bps: number): number {
  return Math.ceil(value * bps / 10_000);
}

function protectedSellingPrice(internalCostIdr: number, targetMarginBps: number): number {
  if (internalCostIdr <= 0) return 0;
  const denominator = 10_000 - targetMarginBps;
  if (denominator <= 0) throw new Error("Target gross margin harus di bawah 100%.");
  return Math.ceil(internalCostIdr * 10_000 / denominator);
}

export function classifyClipScore(score: number, policy: ClipJobPricingPolicy): ClipQualityTier {
  const normalized = Math.max(0, Math.min(100, Number(score || 0)));
  if (normalized >= policy.premiumScoreMin) return "premium";
  if (normalized >= policy.goodScoreMin) return "good";
  if (normalized >= policy.optionalScoreMin) return "optional";
  return "rejected";
}

export function quoteClipJob(input: ClipJobPricingInput, policy: ClipJobPricingPolicy): ClipJobPricingQuote {
  const validation = validateClipJobPricingPolicy(policy);
  if (!validation.valid) throw new Error(validation.errors.join(" "));

  const providerCostIdr = safeInteger(Math.ceil(Number(input.providerCostIdr || 0)), "Provider cost");
  const usableResult = input.usableResult !== false;
  const tierCounts: Record<ClipQualityTier, number> = { rejected: 0, optional: 0, good: 0, premium: 0 };
  for (const score of input.clipScores || []) tierCounts[classifyClipScore(score, policy)] += 1;

  const tierCharges = {
    optional: tierCounts.optional * policy.optionalClipCredits,
    good: tierCounts.good * policy.goodClipCredits,
    premium: tierCounts.premium * policy.premiumClipCredits,
  };
  const acceptedClipCount = tierCounts.optional + tierCounts.good + tierCounts.premium;
  const qualityPriceCredits = usableResult
    ? policy.baseAnalysisCredits + tierCharges.optional + tierCharges.good + tierCharges.premium
    : 0;

  const baseInternalCost = providerCostIdr + (usableResult ? policy.infrastructureFeeIdr : 0);
  const overheadBps = policy.safetyBufferBps + policy.retryAllowanceBps + policy.paymentFeeAllocationBps;
  const internalCostIdr = baseInternalCost + ceilBps(baseInternalCost, overheadBps);
  const protectedPriceIdr = protectedSellingPrice(internalCostIdr, policy.targetGrossMarginBps);
  const protectedPriceCredits = Math.ceil(protectedPriceIdr / policy.creditValueIdr);
  const uncappedCharge = usableResult
    ? Math.max(qualityPriceCredits, policy.minimumJobCredits, protectedPriceCredits)
    : 0;
  const capSafe = policy.maximumJobCredits >= protectedPriceCredits;
  const finalChargeCredits = capSafe
    ? Math.min(uncappedCharge, policy.maximumJobCredits)
    : uncappedCharge;
  const customerRevenueIdr = finalChargeCredits * policy.creditValueIdr;
  const grossProfitIdr = customerRevenueIdr - internalCostIdr;
  const grossMarginBps = customerRevenueIdr > 0
    ? Math.floor(grossProfitIdr * 10_000 / customerRevenueIdr)
    : 0;
  const budgetStatus: JobBudgetStatus = providerCostIdr >= policy.hardProviderCostIdr
    ? "hard-limit"
    : providerCostIdr >= policy.warningProviderCostIdr ? "warning" : "target";

  return {
    providerCostIdr,
    internalCostIdr,
    protectedPriceIdr,
    qualityPriceCredits,
    protectedPriceCredits,
    finalChargeCredits,
    reservationCredits: policy.maximumJobCredits,
    grossProfitIdr,
    grossMarginBps,
    capApplied: capSafe && uncappedCharge > policy.maximumJobCredits,
    capSafe,
    budgetStatus,
    acceptedClipCount,
    rejectedClipCount: tierCounts.rejected,
    tierCounts,
    tierCharges,
  };
}

export function validateClipJobPricingPolicy(policy: ClipJobPricingPolicy): ClipJobPricingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const read = (value: unknown, label: string, minimum = 0) => {
    try {
      return safeInteger(value, label, minimum);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${label} tidak valid.`);
      return minimum;
    }
  };
  const readBps = (value: unknown, label: string, maximum = 9_500) => {
    try {
      return safeBps(value, label, maximum);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${label} tidak valid.`);
      return 0;
    }
  };

  const creditValueIdr = read(policy.creditValueIdr, "Nilai credit", 1);
  const minimumMarginBps = readBps(policy.minimumGrossMarginBps, "Minimum gross margin");
  const targetMarginBps = readBps(policy.targetGrossMarginBps, "Target gross margin");
  const maximumJobCredits = read(policy.maximumJobCredits, "Maximum job credits", 1);
  const minimumJobCredits = read(policy.minimumJobCredits, "Minimum job credits");
  const baseAnalysisCredits = read(policy.baseAnalysisCredits, "Base analysis credits");
  const hardProviderCostIdr = read(policy.hardProviderCostIdr, "Hard provider cost");
  const infrastructureFeeIdr = read(policy.infrastructureFeeIdr, "Infrastructure fee");
  const totalOverheadBps = readBps(policy.safetyBufferBps, "Safety buffer", 10_000)
    + readBps(policy.retryAllowanceBps, "Retry allowance", 10_000)
    + readBps(policy.paymentFeeAllocationBps, "Payment fee allocation", 10_000);

  if (minimumMarginBps < 5_000) errors.push("Minimum gross margin tidak boleh di bawah 50%.");
  if (targetMarginBps < minimumMarginBps) errors.push("Target gross margin harus sama atau lebih besar dari minimum gross margin.");
  if (minimumJobCredits > maximumJobCredits) errors.push("Minimum job credits tidak boleh melebihi maximum job credits.");
  if (baseAnalysisCredits > maximumJobCredits) errors.push("Base analysis credits tidak boleh melebihi maximum job credits.");
  if (!(policy.optionalScoreMin >= 0 && policy.optionalScoreMin < policy.goodScoreMin && policy.goodScoreMin < policy.premiumScoreMin && policy.premiumScoreMin <= 100)) {
    errors.push("Threshold score harus berurutan: optional < good < premium <= 100.");
  }
  if (!(policy.targetProviderCostIdr <= policy.warningProviderCostIdr && policy.warningProviderCostIdr <= policy.hardProviderCostIdr)) {
    errors.push("Budget provider harus berurutan: target <= warning <= hard.");
  }
  if (totalOverheadBps > 30_000) errors.push("Total overhead melebihi batas aman 300%.");

  const hardBaseCost = hardProviderCostIdr + infrastructureFeeIdr;
  const hardInternalCost = hardBaseCost + ceilBps(hardBaseCost, totalOverheadBps);
  const hardProtectedIdr = protectedSellingPrice(hardInternalCost, targetMarginBps);
  const hardLimitProtectedCredits = Math.ceil(hardProtectedIdr / Math.max(1, creditValueIdr));
  if (hardLimitProtectedCredits > maximumJobCredits) {
    errors.push(`Maximum job ${maximumJobCredits} credits tidak menutup protected price ${hardLimitProtectedCredits} credits pada hard cost limit.`);
  }
  if (minimumJobCredits < baseAnalysisCredits) {
    warnings.push("Minimum job lebih rendah dari base analysis; base analysis akan tetap menjadi harga minimum efektif.");
  }
  if (policy.lowBalanceWarningCredits < maximumJobCredits) {
    warnings.push("Low-balance warning lebih rendah dari satu reservation maksimum.");
  }
  return { valid: errors.length === 0, errors, warnings, hardLimitProtectedCredits };
}

export function creditsToMicro(credits: number): number {
  return safeInteger(credits, "Credits") * 1_000_000;
}

export function microToCredits(micro: number): number {
  return Number((safeInteger(micro, "Microcredits") / 1_000_000).toFixed(6));
}

export type PaymentProviderStatus = "pending" | "paid" | "failed" | "expired" | "refunded";

export interface CreateProviderPaymentInput {
  invoiceNumber: string;
  amountIdr: number;
  expiresAt: string;
  customer: { id: string; email: string; displayName: string };
  description: string;
}

export interface CreateProviderPaymentResult {
  provider: string;
  externalId: string;
  status: PaymentProviderStatus;
  paymentUrl?: string;
  qrString?: string;
  qrImageBase64?: string;
  qrImageUrl?: string;
  safeMetadata?: Record<string, unknown>;
}

export interface PaymentWebhookEvent {
  eventId: string;
  externalId: string;
  invoiceNumber: string;
  amountIdr: number;
  status: PaymentProviderStatus;
  occurredAt: string;
}

export interface VerifiedPaymentWebhook {
  verified: boolean;
  reason?: string;
  event?: PaymentWebhookEvent;
  payloadHash: string;
  signature?: string;
}

export interface PaymentProvider {
  readonly code: string;
  createPayment(input: CreateProviderPaymentInput): Promise<CreateProviderPaymentResult>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): VerifiedPaymentWebhook;
  getTransactionStatus?(externalId: string, expectedAmountIdr?: number): Promise<PaymentWebhookEvent>;
  refund?(externalId: string, amountIdr: number): Promise<{ ok: true; reference: string }>;
}

export function paymentEventPayload(event: PaymentWebhookEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    externalId: event.externalId,
    invoiceNumber: event.invoiceNumber,
    amountIdr: event.amountIdr,
    status: event.status,
    occurredAt: event.occurredAt,
  });
}

export function paymentPayloadHash(rawBody: Buffer | string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function signPaymentWebhook(secret: string, rawBody: Buffer | string): string {
  if (secret.length < 24) throw new Error("Webhook secret minimal 24 karakter.");
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyPaymentWebhookSignature(secret: string, rawBody: Buffer, signature: string): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signPaymentWebhook(secret, rawBody), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
