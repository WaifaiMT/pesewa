import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MtnMomo, Paystack, isPayoutProvider } from "../src";
import { mockFetch } from "./mock-fetch";

const REF = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("Paystack payouts", () => {
  const SECRET = "sk_test_secret";
  const sign = (body: string) => createHmac("sha512", SECRET).update(body).digest("hex");
  const recipientRoute = {
    method: "POST",
    match: "/transferrecipient",
    reply: { body: { status: true, message: "Transfer recipient created", data: { recipient_code: "RCP_abc", active: true } } },
  };
  const transferRoute = (status: string) => ({
    method: "POST",
    match: "/transfer",
    reply: { body: { status: true, message: "Transfer has been queued", data: { status, reference: REF, transfer_code: "TRF_1" } } },
  });

  it("registers the wallet as a recipient once, then sends transfers from the balance", async () => {
    const { fetch, calls } = mockFetch([recipientRoute, transferRoute("pending")]);
    const paystack = new Paystack({ secretKey: SECRET, fetch });

    const result = await paystack.payout({ amount: 25000, phone: "+233 24 123 4567", reference: REF.toUpperCase(), name: "Ama Mensah", reason: "Susu round 1" });
    await paystack.payout({ amount: 100, phone: "0241234567", reference: "another-reference-1", name: "Ama Mensah" });

    expect(result).toMatchObject({ status: "pending", reference: REF });
    expect(calls.filter((c) => c.url.endsWith("/transferrecipient"))).toHaveLength(1);
    expect(calls[0].body).toEqual({ type: "mobile_money", name: "Ama Mensah", account_number: "0241234567", bank_code: "MTN", currency: "GHS" });
    expect(calls[1].body).toEqual({ source: "balance", amount: 25000, currency: "GHS", recipient: "RCP_abc", reference: REF, reason: "Susu round 1" });
    expect(calls[1].headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it("uses Telecel and AT bank codes, and lets you override them", async () => {
    const { fetch, calls } = mockFetch([recipientRoute, transferRoute("pending")]);
    await new Paystack({ secretKey: SECRET, fetch }).payout({ amount: 100, phone: "0201234567", reference: REF, name: "Kofi" });
    await new Paystack({ secretKey: SECRET, fetch, transferBankCodes: { at: "AIRTELTIGO" } }).payout({ amount: 100, phone: "0261234567", reference: REF, name: "Yaw" });
    const banks = calls.filter((c) => c.url.endsWith("/transferrecipient")).map((c) => (c.body as { bank_code: string }).bank_code);
    expect(banks).toEqual(["VOD", "AIRTELTIGO"]);
  });

  it("maps transfer statuses", async () => {
    for (const [paystack, ours] of [
      ["success", "success"],
      ["pending", "pending"],
      ["received", "pending"],
      ["queued", "pending"],
      ["failed", "failed"],
      ["rejected", "failed"],
      ["reversed", "reversed"],
    ]) {
      const { fetch } = mockFetch([recipientRoute, transferRoute(paystack)]);
      const result = await new Paystack({ secretKey: SECRET, fetch }).payout({ amount: 100, phone: "0241234567", reference: REF, name: "Ama" });
      expect(result.status, paystack).toBe(ours);
    }
  });

  it("refuses to leave a transfer waiting for an OTP code can't give", async () => {
    const { fetch } = mockFetch([recipientRoute, transferRoute("otp")]);
    await expect(new Paystack({ secretKey: SECRET, fetch }).payout({ amount: 100, phone: "0241234567", reference: REF, name: "Ama" })).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringMatching(/Turn off OTP for transfers/),
    });
  });

  it("checks references and amounts before calling the API", async () => {
    const { fetch, calls } = mockFetch([]);
    const paystack = new Paystack({ secretKey: SECRET, fetch });
    for (const req of [
      { amount: 100, phone: "0241234567", reference: "short", name: "Ama" },
      { amount: 100, phone: "0241234567", reference: "has spaces in it ok?", name: "Ama" },
      { amount: 10.5, phone: "0241234567", reference: REF, name: "Ama" },
      { amount: 100, phone: "0241234567", reference: REF, name: "  " },
    ]) {
      await expect(paystack.payout(req), JSON.stringify(req)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("reports a duplicate reference instead of paying twice", async () => {
    const { fetch } = mockFetch([
      recipientRoute,
      { method: "POST", match: "/transfer", reply: { status: 400, body: { status: false, message: "Duplicate Transaction Reference" } } },
    ]);
    await expect(new Paystack({ secretKey: SECRET, fetch }).payout({ amount: 100, phone: "0241234567", reference: REF, name: "Ama" })).rejects.toMatchObject({
      code: "duplicate_reference",
    });
  });

  it("verifies a transfer", async () => {
    const { fetch, calls } = mockFetch([
      { method: "GET", match: `/transfer/verify/${REF}`, reply: { body: { status: true, data: { status: "reversed", amount: 25000, currency: "GHS", transfer_code: "TRF_1" } } } },
    ]);
    const payout = await new Paystack({ secretKey: SECRET, fetch }).verifyPayout(REF.toUpperCase());
    expect(calls[0].url).toBe(`https://api.paystack.co/transfer/verify/${REF}`);
    expect(payout).toMatchObject({ status: "reversed", amount: 25000, providerTransactionId: "TRF_1", reference: REF });
    expect(payout.failureReason).toMatch(/reversed/);
  });

  it("handles transfer webhooks, ignores charge ones, and the other way round", async () => {
    const { fetch } = mockFetch([
      { method: "GET", match: `/transfer/verify/${REF}`, reply: { body: { status: true, data: { status: "success", amount: 25000 } } } },
    ]);
    const paystack = new Paystack({ secretKey: SECRET, fetch });
    const transferBody = JSON.stringify({ event: "transfer.success", data: { reference: REF } });
    const chargeBody = JSON.stringify({ event: "charge.success", data: { reference: "order-1" } });

    expect(await paystack.handlePayoutWebhook({ body: transferBody, headers: { "x-paystack-signature": sign(transferBody) } })).toMatchObject({
      status: "success",
      amount: 25000,
    });
    expect(await paystack.handlePayoutWebhook({ body: chargeBody, headers: { "x-paystack-signature": sign(chargeBody) } })).toBeNull();
    expect(await paystack.handleWebhook({ body: transferBody, headers: { "x-paystack-signature": sign(transferBody) } })).toBeNull();
    await expect(paystack.handlePayoutWebhook({ body: transferBody, headers: { "x-paystack-signature": sign(chargeBody) } })).rejects.toMatchObject({
      code: "invalid_webhook",
    });
  });
});

describe("MTN MoMo payouts (Disbursement)", () => {
  const collection = { subscriptionKey: "col-key", apiUser: "11111111-1111-4111-8111-111111111111", apiKey: "col-api-key", environment: "sandbox" };
  const disbursement = { subscriptionKey: "dis-key", apiUser: "22222222-2222-4222-8222-222222222222", apiKey: "dis-api-key" };
  const tokenRoute = { method: "POST", match: "/disbursement/token/", reply: { body: { access_token: "dis-tok", expires_in: 3600 } } };

  it("uses the Disbursement keys and token, and the caller's UUID as the X-Reference-Id", async () => {
    const { fetch, calls } = mockFetch([tokenRoute, { method: "POST", match: "/disbursement/v1_0/transfer", reply: { status: 202 } }]);
    const momo = new MtnMomo({ ...collection, disbursement, fetch, callbackUrl: "https://susu.example/api/webhooks/mtn_momo" });

    const result = await momo.payout({ amount: 25000, currency: "EUR", phone: "0241234567", reference: REF, name: "Ama", reason: "Round 1" });

    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${disbursement.apiUser}:dis-api-key`).toString("base64")}`);
    expect(calls[0].headers["Ocp-Apim-Subscription-Key"]).toBe("dis-key");
    const transfer = calls[1];
    expect(transfer.headers).toMatchObject({
      Authorization: "Bearer dis-tok",
      "X-Reference-Id": REF,
      "X-Target-Environment": "sandbox",
      "Ocp-Apim-Subscription-Key": "dis-key",
      "X-Callback-Url": `https://susu.example/api/webhooks/mtn_momo?pesewa_ref=${REF}&pesewa_kind=payout`,
    });
    expect(transfer.body).toEqual({
      amount: "250.00",
      currency: "EUR",
      externalId: REF,
      payee: { partyIdType: "MSISDN", partyId: "233241234567" },
      payerMessage: "Round 1",
      payeeNote: "Round 1",
    });
    expect(result).toMatchObject({ status: "pending", reference: REF });
  });

  it("needs Disbursement keys, a UUID v4 reference, and an MTN number", async () => {
    const { fetch, calls } = mockFetch([]);
    await expect(new MtnMomo({ ...collection, fetch }).payout({ amount: 100, phone: "0241234567", reference: REF, name: "Ama" })).rejects.toMatchObject({
      code: "unsupported",
    });
    const momo = new MtnMomo({ ...collection, disbursement, fetch });
    await expect(momo.payout({ amount: 100, phone: "0241234567", reference: "round-1-payout", name: "Ama" })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/can't pay twice/),
    });
    await expect(momo.payout({ amount: 100, phone: "0201234567", reference: REF, name: "Kofi" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("reports a repeated reference as a duplicate", async () => {
    const { fetch } = mockFetch([tokenRoute, { method: "POST", match: "/disbursement/v1_0/transfer", reply: { status: 409 } }]);
    await expect(new MtnMomo({ ...collection, disbursement, fetch }).payout({ amount: 100, phone: "0241234567", reference: REF, name: "Ama" })).rejects.toMatchObject({
      code: "duplicate_reference",
    });
  });

  it("verifies transfers", async () => {
    const { fetch } = mockFetch([
      tokenRoute,
      { method: "GET", match: `/disbursement/v1_0/transfer/${REF}`, reply: { body: { status: "FAILED", amount: "250", currency: "EUR", reason: "PAYEE_NOT_FOUND" } } },
    ]);
    expect(await new MtnMomo({ ...collection, disbursement, fetch }).verifyPayout(REF)).toMatchObject({
      status: "failed",
      amount: 25000,
      failureReason: "PAYEE_NOT_FOUND",
    });
  });

  it("tells payout callbacks from collection callbacks by the URL", async () => {
    const { fetch, calls } = mockFetch([
      tokenRoute,
      { method: "GET", match: `/disbursement/v1_0/transfer/${REF}`, reply: { body: { status: "SUCCESSFUL", amount: "250" } } },
    ]);
    const momo = new MtnMomo({ ...collection, disbursement, fetch });
    const payoutUrl = `https://susu.example/api/webhooks/mtn_momo?pesewa_ref=${REF}&pesewa_kind=payout`;
    const collectionUrl = `https://susu.example/api/webhooks/mtn_momo?pesewa_ref=${REF}`;

    expect(await momo.handleWebhook({ body: "{}", headers: {}, url: payoutUrl })).toBeNull();
    expect(await momo.handlePayoutWebhook({ body: "{}", headers: {}, url: collectionUrl })).toBeNull();
    expect(await momo.handlePayoutWebhook({ body: "{}", headers: {}, url: payoutUrl })).toMatchObject({ status: "success", amount: 25000 });
    expect(calls.filter((c) => c.url.includes("/collection/"))).toHaveLength(0);
  });

  it("keeps collections on the Collection keys when both are configured", async () => {
    const { fetch, calls } = mockFetch([
      { method: "POST", match: "/collection/token/", reply: { body: { access_token: "col-tok", expires_in: 3600 } } },
      { method: "POST", match: "/collection/v1_0/requesttopay", reply: { status: 202 } },
    ]);
    await new MtnMomo({ ...collection, disbursement, fetch }).collect({ amount: 100, phone: "0241234567", reference: REF });
    expect(calls[1].headers).toMatchObject({ Authorization: "Bearer col-tok", "Ocp-Apim-Subscription-Key": "col-key" });
  });
});

describe("isPayoutProvider", () => {
  it("is true for providers that can pay out", () => {
    expect(isPayoutProvider(new Paystack({ secretKey: "sk_test_x" }))).toBe(true);
    expect(isPayoutProvider(new MtnMomo({ subscriptionKey: "a", apiUser: "b", apiKey: "c", environment: "sandbox" }))).toBe(true);
    expect(isPayoutProvider({ name: "x" })).toBe(false);
  });
});
