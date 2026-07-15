export interface UsageCostInput {
  providerCostMicroUsd: bigint;
  computeCostMicroUsd?: bigint;
  paymentFeeBps?: number;
  reserveBps?: number;
  minimumChargeMicroUsd?: bigint;
  markupBps: number;
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

export function quoteUsageCost(input: UsageCostInput): UsageCostQuote {
  if (input.providerCostMicroUsd < 0n || (input.computeCostMicroUsd ?? 0n) < 0n || (input.minimumChargeMicroUsd ?? 0n) < 0n) throw new Error("Cost tidak boleh negatif.");
  if (input.microUsdPerCredit <= 0n) throw new Error("Nilai credit harus lebih besar dari nol.");
  const computeCost = input.computeCostMicroUsd ?? 0n;
  const baseCost = input.providerCostMicroUsd + computeCost;
  const overhead = bpsCharge(baseCost, (input.paymentFeeBps ?? 0) + (input.reserveBps ?? 0));
  const serviceCost = [baseCost + overhead, input.minimumChargeMicroUsd ?? 0n].reduce((largest, value) => value > largest ? value : largest, 0n);
  const userCharge = serviceCost + bpsCharge(serviceCost, input.markupBps);
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
    markupBps: input.markupBps,
    grossMarginBps,
  };
}
