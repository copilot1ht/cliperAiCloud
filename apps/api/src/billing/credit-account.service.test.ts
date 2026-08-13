import { afterEach, describe, expect, it } from "vitest";
import { CreditAccountService } from "./credit-account.service.js";

const originalBalance = process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;
afterEach(() => {
  if (originalBalance === undefined) delete process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;
  else process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = originalBalance;
});

describe("CreditAccountService", () => {
  it("reserves, settles, and records an immutable-style transaction trail", () => {
    process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "1000";
    const service = new CreditAccountService();
    const reservation = service.reserve("account-a", "request-a", 400);
    expect(service.balance("account-a")).toMatchObject({ balanceMicro: 1000, reservedMicro: 400, availableMicro: 600 });
    service.settle(reservation.id, 250);
    expect(service.balance("account-a")).toMatchObject({ balanceMicro: 750, reservedMicro: 0, availableMicro: 750 });
    expect(service.transactions("account-a").map((item) => item.type)).toEqual(["settle", "release", "reserve"]);
  });

  it("releases a reservation without charging a failed request", () => {
    process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "500";
    const service = new CreditAccountService();
    const reservation = service.reserve("account-b", "request-b", 300);
    service.release(reservation.id);
    expect(service.balance("account-b")).toMatchObject({ balanceMicro: 500, reservedMicro: 0 });
  });

  it("rejects a job when its own USD reservation exceeds the spendable wallet", () => {
    process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "100";
    expect(() => new CreditAccountService().reserve("account-c", "request-c", 101)).toThrow(/tidak mencukupi/i);
  });

  it("allows a US$0.005 job when the wallet has US$0.01", () => {
    process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "10000";
    const reservation = new CreditAccountService().reserve("account-small", "request-small", 5_000);
    expect(reservation.amountMicro).toBe(5_000);
  });

  it("keeps every reservation intact when settlement cannot cover the actual charge", () => {
    process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "1000";
    const service = new CreditAccountService();
    const first = service.reserve("account-d", "request-d1", 600);
    service.reserve("account-d", "request-d2", 400);
    expect(() => service.settle(first.id, 800)).toThrow(/settlement/i);
    expect(service.balance("account-d")).toMatchObject({ balanceMicro: 1000, reservedMicro: 1000, availableMicro: 0 });
  });

  it("returns the same reservation for a repeated account request key", () => {
    process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "1000";
    const service = new CreditAccountService();
    const first = service.reserve("account-e", "job-e", 600);
    const duplicate = service.reserve("account-e", "job-e", 600);
    expect(duplicate.id).toBe(first.id);
    expect(service.balance("account-e")).toMatchObject({ reservedMicro: 600, availableMicro: 400 });
  });
});
