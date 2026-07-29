import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectCreditService } from "./direct-credit.service.js";

const originalStorage = process.env.ANALYSIS_BILLING_STORAGE;

afterEach(() => {
  if (originalStorage === undefined) delete process.env.ANALYSIS_BILLING_STORAGE;
  else process.env.ANALYSIS_BILLING_STORAGE = originalStorage;
});

describe("DirectCreditService", () => {
  it("does not reserve or debit the wallet for an unlimited owner", async () => {
    process.env.ANALYSIS_BILLING_STORAGE = "postgres";
    const client = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ unlimitedCredits: true }),
      },
      $transaction: vi.fn(),
    };
    const database = {
      configured: () => true,
      client: () => client,
    };
    const memory = {
      reserve: vi.fn(),
      settle: vi.fn(),
      release: vi.fn(),
    };
    const credits = new DirectCreditService(memory as never, database as never);

    const reservation = await credits.reserve("owner-a", "key-a", "request-a", 12_000);
    await credits.settle(reservation, 11_000);

    expect(reservation).toMatchObject({
      accountId: "owner-a",
      apiKeyId: "key-a",
      requestId: "request-a",
      amountMicro: 0,
      unlimited: true,
      persistent: true,
    });
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(memory.reserve).not.toHaveBeenCalled();
  });

  it("keeps the in-memory fallback behavior for isolated tests", async () => {
    process.env.ANALYSIS_BILLING_STORAGE = "memory";
    const memoryReservation = {
      id: "memory-reservation",
      accountId: "member-a",
      requestId: "request-a",
      amountMicro: 2_000,
    };
    const memory = {
      reserve: vi.fn().mockReturnValue(memoryReservation),
      settle: vi.fn(),
      release: vi.fn(),
    };
    const credits = new DirectCreditService(memory as never);

    const reservation = await credits.reserve("member-a", "key-a", "request-a", 2_000);
    await credits.settle(reservation, 1_750);

    expect(memory.reserve).toHaveBeenCalledWith("member-a", "request-a", 2_000);
    expect(memory.settle).toHaveBeenCalledWith("memory-reservation", 1_750);
  });
});
