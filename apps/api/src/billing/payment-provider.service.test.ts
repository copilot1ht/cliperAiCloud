import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentWebhookEvent } from "@cliper/billing";
import { createHash } from "node:crypto";
import {
  MidtransPaymentProvider,
  SandboxPaymentProvider,
  XenditPaymentProvider,
} from "./payment-provider.service.js";

describe("SandboxPaymentProvider", () => {
  const provider = new SandboxPaymentProvider(
    "payment-secret-with-at-least-32-characters",
    "http://localhost:3000",
  );
  const event: PaymentWebhookEvent = {
    eventId: "sbx-event-001",
    externalId: "sbx-payment-001",
    invoiceNumber: "CLP-20260715-TEST",
    amountIdr: 99_000,
    status: "paid",
    occurredAt: "2026-07-15T00:00:00.000Z",
  };

  afterEach(() => {
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.ALLOW_SANDBOX_PAYMENTS;
  });

  it("creates a unique dynamic sandbox payment reference", async () => {
    const first = await provider.createPayment({
      invoiceNumber: "INV-1",
      amountIdr: 99_000,
      expiresAt: new Date().toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Starter",
    });
    const second = await provider.createPayment({
      invoiceNumber: "INV-2",
      amountIdr: 99_000,
      expiresAt: new Date().toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Starter",
    });
    expect(first.externalId).not.toBe(second.externalId);
    expect(first.qrString).toMatch(/^CLIPER-SANDBOX:/);
    expect(first.qrImageBase64).toMatch(/^data:image\/png;base64,/);
  });

  it("verifies the exact signed webhook body", () => {
    const signed = provider.signedEvent(event);
    expect(
      provider.verifyWebhook(signed.rawBody, {
        "x-cliper-signature": signed.signature,
      }),
    ).toMatchObject({ verified: true, event });
    expect(
      provider.verifyWebhook(Buffer.from(`${signed.rawBody.toString()} `), {
        "x-cliper-signature": signed.signature,
      }).verified,
    ).toBe(false);
  });
});

describe("MidtransPaymentProvider", () => {
  const serverKey = "SB-Mid-server-test-key-with-enough-length";
  const provider = new MidtransPaymentProvider(
    serverKey,
    "https://cliper.example",
    false,
    "gopay",
    "https://api.cliper.example/api/payments/webhook/midtrans",
  );

  afterEach(() => vi.unstubAllGlobals());

  it("creates QRIS through Core API and embeds the PNG without exposing the server key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transaction_id: "trx-qris-1",
            order_id: "CLP-20260715-TEST",
            gross_amount: "25000.00",
            payment_type: "qris",
            qr_string: "00020101021226610014COM.MIDTRANS.WWW",
            actions: [
              {
                name: "generate-qr-code",
                method: "GET",
                url: "https://api.sandbox.midtrans.com/v2/qris/trx-qris-1/qr-code",
              },
            ],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          Buffer.from("valid-png-image-placeholder-data".repeat(3)),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await provider.createPayment({
      invoiceNumber: "CLP-20260715-TEST",
      amountIdr: 25_000,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Top-up",
    });
    expect(result.provider).toBe("midtrans");
    expect(result.qrImageBase64).toMatch(/^data:image\/png;base64,/);
    expect(result.safeMetadata).toMatchObject({
      checkout: "core-api",
      paymentType: "qris",
    });
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls[0]?.[0]).toBe("https://api.sandbox.midtrans.com/v2/charge");
    const request = calls[0]?.[1] || {};
    expect(
      String(
        request.headers &&
          (request.headers as Record<string, string>).Authorization,
      ),
    ).not.toContain(serverKey);
    expect(String(request.body)).toContain("25000");
    expect(
      (request.headers as Record<string, string>)["X-Override-Notification"],
    ).toBe("https://api.cliper.example/api/payments/webhook/midtrans");
    const qrRequest = calls[1]?.[1] || {};
    expect(qrRequest.redirect).toBe("error");
  });

  it("accepts equivalent pending QRIS fields and creates a scannable data URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction_details: {
                order_id: "CLP-20260715-NORMALIZED",
                gross_amount: "17000.00",
              },
              payment_type: "QRIS",
              transaction_status: "pending",
              qr_string: "00020101021226610014COM.MIDTRANS.WWW",
            }),
            { status: 201 },
          ),
      ),
    );
    const result = await provider.createPayment({
      invoiceNumber: "CLP-20260715-NORMALIZED",
      amountIdr: 17_000,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Top-up",
    });
    expect(result.qrImageBase64).toMatch(/^data:image\/png;base64,/);
  });

  it("accepts a Core API transaction wrapped by a transport envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status_code: "201",
              data: {
                order_id: "CLP-20260715-WRAPPED",
                gross_amount: "17000.00",
                payment_type: "qris",
                transaction_status: "pending",
                qr_string: "00020101021226610014COM.MIDTRANS.WWW",
              },
            }),
            { status: 201 },
          ),
      ),
    );

    const result = await provider.createPayment({
      invoiceNumber: "CLP-20260715-WRAPPED",
      amountIdr: 17_000,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Top-up",
    });

    expect(result.qrImageBase64).toMatch(/^data:image\/png;base64,/);
  });

  it("reports an actionable schema error for an incomplete QRIS response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status_code: "201",
              status_message: "QRIS transaction is created",
              transaction_id: "trx-without-core-fields",
            }),
            { status: 201 },
          ),
      ),
    );

    await expect(
      provider.createPayment({
        invoiceNumber: "CLP-20260715-SCHEMA",
        amountIdr: 17_000,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        customer: { id: "u1", email: "user@example.com", displayName: "User" },
        description: "Top-up",
      }),
    ).rejects.toThrow("MIDTRANS_RESPONSE_SCHEMA_INVALID");
  });

  it("classifies Midtrans provider rejections before QRIS schema validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "provider-error-id",
              status_code: "402",
              status_message:
                "GoPay Dynamic QRIS is not active for this merchant",
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      provider.createPayment({
        invoiceNumber: "CLP-20260715-PROVIDER-REJECTED",
        amountIdr: 17_000,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        customer: { id: "u1", email: "user@example.com", displayName: "User" },
        description: "Top-up",
      }),
    ).rejects.toThrow("MIDTRANS_PROVIDER_REJECTED");
  });

  it("preserves a non-2xx Midtrans response as a provider rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status_code: "401",
              status_message: "Access denied",
            }),
            { status: 401 },
          ),
      ),
    );

    await expect(
      provider.createPayment({
        invoiceNumber: "CLP-20260715-PROVIDER-HTTP-REJECTED",
        amountIdr: 17_000,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        customer: { id: "u1", email: "user@example.com", displayName: "User" },
        description: "Top-up",
      }),
    ).rejects.toThrow("MIDTRANS_PROVIDER_REJECTED");
  });

  it("reports exact safe codes for mismatched QRIS invoice fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              order_id: "CLP-20260715-OTHER",
              gross_amount: "17001.00",
              payment_type: "qris",
              transaction_status: "pending",
              qr_string: "00020101021226610014COM.MIDTRANS.WWW",
            }),
            { status: 201 },
          ),
      ),
    );
    await expect(
      provider.createPayment({
        invoiceNumber: "CLP-20260715-MISMATCH",
        amountIdr: 17_000,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        customer: { id: "u1", email: "user@example.com", displayName: "User" },
        description: "Top-up",
      }),
    ).rejects.toThrow("MIDTRANS_ORDER_ID_MISMATCH, MIDTRANS_AMOUNT_MISMATCH");
  });

  it("rejects a QR response that is not a PNG", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transaction_id: "trx-qris-invalid-image",
            order_id: "CLP-20260715-INVALID-IMAGE",
            gross_amount: "25000.00",
            payment_type: "qris",
            actions: [
              {
                name: "generate-qr-code",
                url: "https://api.sandbox.midtrans.com/v2/qris/trx-qris-invalid-image/qr-code",
              },
            ],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response("not an image", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.createPayment({
        invoiceNumber: "CLP-20260715-INVALID-IMAGE",
        amountIdr: 25_000,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        customer: {
          id: "u1",
          email: "user@example.com",
          displayName: "User",
        },
        description: "Top-up",
      }),
    ).rejects.toThrow("tipe file");
  });

  it("always requests QRIS even when no payment selector is sent", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            transaction_id: "trx-qris-2",
            order_id: "CLP-20260715-QRIS",
            gross_amount: "25000.00",
            payment_type: "qris",
            qr_string: "00020101021226610014COM.MIDTRANS.WWW",
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await provider.createPayment({
      invoiceNumber: "CLP-20260715-QRIS",
      amountIdr: 25_000,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Top-up",
    });
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const body = JSON.parse(String(calls[0]?.[1]?.body || "{}")) as {
      payment_type?: string;
      qris?: { acquirer?: string };
    };
    expect(body.payment_type).toBe("qris");
    expect(body.qris?.acquirer).toBe("gopay");
  });

  it("uses a signed QR payload when the separate QR PNG is temporarily unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status_code: "201",
            status_message: "QRIS transaction is created",
            order_id: "CLP-20260715-FALLBACK",
            gross_amount: "25000.00",
            payment_type: "qris",
            qr_string: "00020101021226610014COM.MIDTRANS.WWW",
            actions: [
              {
                name: "generate-qr-code-v2",
                url: "https://api.sandbox.midtrans.com/v4/qris/trx-fallback/qr-code",
              },
            ],
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.createPayment({
      invoiceNumber: "CLP-20260715-FALLBACK",
      amountIdr: 25_000,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Top-up",
    });

    expect(result.qrImageBase64).toMatch(/^data:image\/png;base64,/);
  });

  it("validates Midtrans signature and maps settlement to paid", () => {
    const orderId = "CLP-20260715-TEST";
    const grossAmount = "25000.00";
    const statusCode = "200";
    const signature = createHash("sha512")
      .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
      .digest("hex");
    const raw = Buffer.from(
      JSON.stringify({
        order_id: orderId,
        status_code: statusCode,
        gross_amount: grossAmount,
        signature_key: signature,
        transaction_status: "settlement",
        transaction_id: "trx-1",
        transaction_time: "2026-07-15 12:00:00",
      }),
    );
    expect(provider.verifyWebhook(raw, {})).toMatchObject({
      verified: true,
      event: { externalId: orderId, amountIdr: 25_000, status: "paid" },
    });
    expect(
      provider.verifyWebhook(
        Buffer.from(raw.toString().replace("25000.00", "26000.00")),
        {},
      ).verified,
    ).toBe(false);
  });

  it("refuses a production-shaped key in sandbox mode", () => {
    expect(
      () =>
        new MidtransPaymentProvider(
          "Mid-server-production-key-with-enough-length",
          "http://localhost:3000",
          false,
        ),
    ).toThrow("Sandbox");
  });

  it("reads the official transaction status without exposing the server key", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            order_id: "CLP-20260715-TEST",
            gross_amount: "25000.00",
            transaction_status: "settlement",
            transaction_id: "trx-status-1",
            settlement_time: "2026-07-15 12:00:00",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const event = await provider.getTransactionStatus("CLP-20260715-TEST");
    expect(event).toMatchObject({
      externalId: "CLP-20260715-TEST",
      invoiceNumber: "CLP-20260715-TEST",
      amountIdr: 25_000,
      status: "paid",
    });
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls[0]?.[0]).toContain("/v2/CLP-20260715-TEST/status");
    expect(
      String(
        calls[0]?.[1]?.headers &&
          (calls[0][1].headers as Record<string, string>).Authorization,
      ),
    ).not.toContain(serverKey);
  });

  it("keeps a QRIS invoice pending before settlement", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status_code: "404",
            status_message: "The requested resource is not found",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const event = await provider.getTransactionStatus(
      "CLP-20260715-PENDING",
      25_000,
    );
    expect(event).toMatchObject({
      externalId: "CLP-20260715-PENDING",
      invoiceNumber: "CLP-20260715-PENDING",
      amountIdr: 25_000,
      status: "pending",
    });
  });

  it("treats an HTTP 404 status lookup as a pending checkout instead of a provider outage", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status_code: "404",
            status_message: "The requested resource is not found",
          }),
          { status: 404 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.getTransactionStatus("CLP-20260715-NOT-OPENED", 25_000),
    ).resolves.toMatchObject({
      externalId: "CLP-20260715-NOT-OPENED",
      status: "pending",
    });
  });
});

describe("XenditPaymentProvider", () => {
  const secretKey = "xendit-secret-key-with-at-least-32-characters";
  const callbackToken = "xendit-webhook-token-with-at-least-32-characters";
  const provider = new XenditPaymentProvider({
    secretKey,
    webhookToken: callbackToken,
    mode: "test",
    apiVersion: "2024-11-11",
    notificationUrl: "https://api.example.com/api/payments/webhook/xendit",
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates a QRIS payment request and extracts QR_STRING semantically", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            payment_request_id: "pr-00000000-0000-0000-0000-000000000001",
            reference_id: "CLP-20260809-XENDIT",
            request_amount: 17_000,
            channel_code: "QRIS",
            status: "REQUIRES_ACTION",
            actions: [
              {
                type: "PRESENT_TO_CUSTOMER",
                descriptor: "QR_STRING",
                value: "00020101021226610014COM.XENDIT.QRIS",
              },
            ],
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.createPayment({
      invoiceNumber: "CLP-20260809-XENDIT",
      amountIdr: 17_000,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      customer: { id: "u1", email: "user@example.com", displayName: "User" },
      description: "Cliper top-up",
    });

    expect(result).toMatchObject({
      provider: "xendit",
      externalId: "pr-00000000-0000-0000-0000-000000000001",
      qrString: "00020101021226610014COM.XENDIT.QRIS",
    });
    expect(result.qrImageBase64).toMatch(/^data:image\/png;base64,/);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe("https://api.xendit.co/v3/payment_requests");
    const request = calls[0]?.[1] || {};
    expect(String(request.body)).toContain('"channel_code":"QRIS"');
    expect(String((request.headers as Record<string, string>).Authorization)).not.toContain(secretKey);
  });

  it("rejects a response without a QR action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              payment_request_id: "pr-00000000-0000-0000-0000-000000000002",
              reference_id: "CLP-20260809-NO-QR",
              request_amount: 17_000,
              channel_code: "QRIS",
              actions: [],
            }),
            { status: 201 },
          ),
      ),
    );

    await expect(
      provider.createPayment({
        invoiceNumber: "CLP-20260809-NO-QR",
        amountIdr: 17_000,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        customer: { id: "u1", email: "user@example.com", displayName: "User" },
        description: "Cliper top-up",
      }),
    ).rejects.toThrow("XENDIT_QR_ACTION_MISSING");
  });

  it("verifies a callback token and normalizes a successful payment", () => {
    const raw = Buffer.from(
      JSON.stringify({
        event: "payment.capture",
        created: "2026-08-09T00:00:00.000Z",
        data: {
          payment_id: "py-00000000-0000-0000-0000-000000000001",
          payment_request_id: "pr-00000000-0000-0000-0000-000000000001",
          reference_id: "CLP-20260809-XENDIT",
          request_amount: 17_000,
          status: "SUCCEEDED",
          updated: "2026-08-09T00:01:00.000Z",
        },
      }),
    );
    expect(
      provider.verifyWebhook(raw, { "x-callback-token": callbackToken }),
    ).toMatchObject({
      verified: true,
      event: {
        externalId: "pr-00000000-0000-0000-0000-000000000001",
        invoiceNumber: "CLP-20260809-XENDIT",
        amountIdr: 17_000,
        status: "paid",
      },
    });
    expect(provider.verifyWebhook(raw, { "x-callback-token": "invalid" }).verified).toBe(false);
  });

  it("acknowledges a verified informational webhook without creating an event", () => {
    const raw = Buffer.from(JSON.stringify({ event: "payment_request.status", data: {} }));
    const result = provider.verifyWebhook(raw, {
      "x-callback-token": callbackToken,
    });
    expect(result.verified).toBe(true);
    expect(result.event).toBeUndefined();
  });

  it("normalizes payment-request status sync", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              payment_request_id: "pr-00000000-0000-0000-0000-000000000003",
              reference_id: "CLP-20260809-SYNC",
              request_amount: 17_000,
              status: "SUCCEEDED",
              updated: "2026-08-09T00:01:00.000Z",
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      provider.getTransactionStatus("pr-00000000-0000-0000-0000-000000000003", 17_000),
    ).resolves.toMatchObject({ invoiceNumber: "CLP-20260809-SYNC", status: "paid" });
  });

  it("uses Xendit's test-only simulator without marking an invoice paid locally", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "PENDING" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.simulatePayment(
        "pr-00000000-0000-0000-0000-000000000003",
        17_000,
      ),
    ).resolves.toEqual({ ok: true, status: "PENDING" });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, request] = firstCall as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.xendit.co/v3/payment_requests/pr-00000000-0000-0000-0000-000000000003/simulate",
    );
    expect(request.method).toBe("POST");
    expect(request.body).toBe(JSON.stringify({ amount: 17_000 }));
  });

  it("does not expose the simulator when the provider runs in live mode", async () => {
    const liveProvider = new XenditPaymentProvider({
      secretKey,
      webhookToken: callbackToken,
      mode: "live",
      apiVersion: "2024-11-11",
      notificationUrl: "https://api.example.com/api/payments/webhook/xendit",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      liveProvider.simulatePayment(
        "pr-00000000-0000-0000-0000-000000000003",
        17_000,
      ),
    ).rejects.toThrow("XENDIT_MODE=test");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
