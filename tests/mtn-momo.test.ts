import { describe, expect, it } from "vitest";
import { MtnMomo } from "../src";
import { mockFetch } from "./mock-fetch";

const options = { subscriptionKey: "sub-key", apiUser: "11111111-1111-4111-8111-111111111111", apiKey: "api-key", environment: "sandbox" };
const tokenRoute = { method: "POST", match: "/collection/token/", reply: { body: { access_token: "tok", token_type: "access_token", expires_in: 3600 } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("MTN MoMo", () => {
  it("gets a token with basic auth and sends a Request to Pay", async () => {
    const { fetch, calls } = mockFetch([tokenRoute, { method: "POST", match: "/collection/v1_0/requesttopay", reply: { status: 202 } }]);
    const momo = new MtnMomo({ ...options, fetch, callbackUrl: "https://shop.example/momo/callback" });

    const result = await momo.collect({ amount: 1050, currency: "EUR", phone: "0241234567", reference: "order-1", description: "Order 1" });

    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${options.apiUser}:api-key`).toString("base64")}`);
    expect(calls[0].headers["Ocp-Apim-Subscription-Key"]).toBe("sub-key");

    const rtp = calls[1];
    expect(rtp.url).toBe("https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay");
    expect(rtp.headers).toMatchObject({ Authorization: "Bearer tok", "X-Target-Environment": "sandbox", "Ocp-Apim-Subscription-Key": "sub-key" });
    expect(rtp.headers["X-Reference-Id"]).toMatch(UUID);
    expect(rtp.headers["X-Callback-Url"]).toBe(`https://shop.example/momo/callback?pesewa_ref=${rtp.headers["X-Reference-Id"]}`);
    expect(rtp.body).toEqual({
      amount: "10.50",
      currency: "EUR",
      externalId: "order-1",
      payer: { partyIdType: "MSISDN", partyId: "233241234567" },
      payerMessage: "Order 1",
      payeeNote: "Order 1",
    });
    expect(result).toMatchObject({ status: "pending", reference: rtp.headers["X-Reference-Id"] });
  });

  it("reuses the access token until it expires", async () => {
    const { fetch, calls } = mockFetch([tokenRoute, { method: "POST", match: "/requesttopay", reply: { status: 202 } }]);
    const momo = new MtnMomo({ ...options, fetch });
    await momo.collect({ amount: 100, phone: "0541234567", reference: "a" });
    await momo.collect({ amount: 100, phone: "0541234567", reference: "b" });
    expect(calls.filter((c) => c.url.endsWith("/collection/token/"))).toHaveLength(1);
  });

  it("refuses non-MTN numbers before calling the API", async () => {
    const { fetch, calls } = mockFetch([]);
    await expect(new MtnMomo({ ...options, fetch }).collect({ amount: 100, phone: "0201234567", reference: "x" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["SUCCESSFUL", "success"],
    ["PENDING", "pending"],
    ["FAILED", "failed"],
  ])("maps %s to %s", async (mtnStatus, status) => {
    const { fetch } = mockFetch([
      tokenRoute,
      { method: "GET", match: /requesttopay\/ref-1$/, reply: { body: { amount: "10.5", currency: "EUR", financialTransactionId: "fin-1", externalId: "order-1", status: mtnStatus } } },
    ]);
    const payment = await new MtnMomo({ ...options, fetch }).verify("ref-1");
    expect(payment).toMatchObject({ status, amount: 1050, currency: "EUR", providerTransactionId: "fin-1" });
  });

  it("confirms callbacks with the status API, using the reference from the callback URL", async () => {
    const ref = "22222222-2222-4222-8222-222222222222";
    const { fetch, calls } = mockFetch([tokenRoute, { method: "GET", match: `/requesttopay/${ref}`, reply: { body: { status: "SUCCESSFUL", amount: "5" } } }]);
    const payment = await new MtnMomo({ ...options, fetch }).handleWebhook({
      // A forged body claiming success doesn't matter: only MTN's status endpoint is trusted
      body: JSON.stringify({ status: "SUCCESSFUL", amount: "999999" }),
      headers: {},
      url: `/momo/callback?pesewa_ref=${ref}`,
    });
    expect(payment).toMatchObject({ status: "success", amount: 500, reference: ref });
    expect(calls.some((c) => c.method === "GET")).toBe(true);
  });

  it("rejects callbacks without a valid reference", async () => {
    const momo = new MtnMomo({ ...options, fetch: mockFetch([]).fetch });
    await expect(momo.handleWebhook({ body: "{}", headers: {}, url: "/momo/callback" })).rejects.toMatchObject({ code: "invalid_webhook" });
    await expect(momo.handleWebhook({ body: "{}", headers: {}, url: "/cb?pesewa_ref=../../etc" })).rejects.toMatchObject({ code: "invalid_webhook" });
  });

  it("requires an explicit host outside the sandbox and has no OTP step", async () => {
    expect(() => new MtnMomo({ ...options, environment: "mtnghana" })).toThrow(/baseUrl is required/);
    await expect(new MtnMomo(options).submitOtp()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("maps HTTP errors", async () => {
    const { fetch } = mockFetch([
      tokenRoute,
      { method: "POST", match: "/requesttopay", reply: { status: 409, body: { code: "RESOURCE_ALREADY_EXIST" } } },
      { method: "GET", match: /requesttopay\/gone$/, reply: { status: 404 } },
    ]);
    const momo = new MtnMomo({ ...options, fetch });
    await expect(momo.collect({ amount: 100, phone: "0241234567", reference: "r" })).rejects.toMatchObject({ code: "duplicate_reference" });
    await expect(momo.verify("gone")).rejects.toMatchObject({ code: "not_found" });
  });
});
