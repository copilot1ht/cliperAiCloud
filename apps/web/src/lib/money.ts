const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatUsdWallet(value: string | number | null | undefined): string {
  const amount = Number(value ?? 0);
  return USD_FORMATTER.format(Number.isFinite(amount) ? amount : 0);
}

export function formatUsdMicro(value: string | number | bigint | null | undefined): string {
  try {
    return formatUsdWallet(Number(BigInt(value ?? 0)) / 1_000_000);
  } catch {
    return formatUsdWallet(0);
  }
}
