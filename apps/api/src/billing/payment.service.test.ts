import { afterEach, describe, expect, it } from "vitest";
import {
  configuredTopupMinimumIdr,
  configuredTopupMinimumUsd,
  configuredTopupUsdToIdrDisplayRate,
} from "./payment.service.js";

describe("Billing top-up helpers", () => {
  afterEach(() => {
    delete process.env.PAYMENT_MIN_TOPUP_IDR;
    delete process.env.PAYMENT_MIN_TOPUP_USD;
    delete process.env.PAYMENT_USD_TO_IDR_DISPLAY_RATE;
    delete process.env.PLATFORM_USD_TO_IDR;
  });

  it("uses the greater of the legacy IDR guard and the USD minimum", () => {
    process.env.PAYMENT_MIN_TOPUP_IDR = "100000";
    expect(configuredTopupMinimumIdr()).toBe(100000);
  });

  it("defaults to a US$3 equivalent, paid in IDR", () => {
    expect(configuredTopupMinimumUsd()).toBe(3);
    expect(configuredTopupUsdToIdrDisplayRate()).toBe(17700);
    expect(configuredTopupMinimumIdr()).toBe(53100);
  });

  it("ignores invalid top-up overrides", () => {
    process.env.PAYMENT_MIN_TOPUP_IDR = "not-a-number";
    process.env.PAYMENT_MIN_TOPUP_USD = "not-a-number";
    process.env.PAYMENT_USD_TO_IDR_DISPLAY_RATE = "not-a-number";
    expect(configuredTopupMinimumIdr()).toBe(53100);
  });
});
