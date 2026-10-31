import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Paystack } from "../src";
import { mockFetch } from "./mock-fetch";

const SECRET = "sk_test_secret";
const sign = (body: string) => createHmac("sha512", SECRET).update(body).digest("hex");

const verified = (status: string) => ({
  body: { status: true, message: "Verification successful", data: { id: 42, status, amount: 1050, currency: "GHS", paid_at: "2026-10-31T10:00:00.000Z", gateway_response: "Approved", reference: "order-1" } },
});

describe("Paystack", () => {
  it("charges mobile money with the right body, auth, and provider code", async () => {
    const { fetch, calls } = mockFetch([
      { method: "POST", match: "/charge", reply: { body: { status: true, message: "Charge attempted", data: { status: "pay_offline", display_text: "Approve the prompt on your phone" } } } },
    ]);
    const paystack = new Paystack({ secretKey: SECRET, fetch });

    const result = await paystack.collect({ amount: 1050, phone: "+233 20 123 4567", reference: "order-1", email: "ama@example.com" });

    expect(result).toMatchObject({ status: "pending", reference: "order-1", message: "Approve the prompt on your phone" });
    expect(calls[0].url).toBe("https://api.paystack.co/charge");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0].body).toEqual({
      email: "ama@example.com",
      amount: 1050,
      currency: "GHS",
      reference: "order-1",
      mobile_money: { phone: "0201234567", provider: "vod" },
    });
  });

  it("maps send_otp to otp_required and submits the OTP", async () => {
    const { fetch, calls } = mockFetch([
      { method: "POST", match: "/charge/submit_otp", reply: { body: { status: true, data: { status: "pay_offline" } } } },
      { method: "POST", match: "/charge", reply: { body: { status: true, data: { status: "send_otp" } } } },
    ]);
    const paystack = new Paystack({ secretKey: SECRET, fetch, fallbackEmailDomain: "payments.example.com" });
    const req = { amount: 500, phone: "0261234567", reference: "order-2" };

    expect((await paystack.collect(req)).status).toBe("otp_required");
    expect(calls[0].body).toMatchObject({ email: "233261234567@payments.example.com", mobile_money: { provider: "atl" } });

    expect((await paystack.submitOtp(req, "123456")).status).toBe("pending");
    expect(calls[1].body).toEqual({ otp: "123456", reference: "order-2" });
  });

  it("requires an email or a fallback domain", async () => {
    const paystack = new Paystack({ secretKey: SECRET, fetch: mockFetch([]).fetch });
    await expect(paystack.collect({ amount: 100, phone: "0241234567", reference: "r" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("verifies a transaction and maps its status", async () => {
    const { fetch } = mockFetch([{ method: "GET", match: "/transaction/verify/order-1", reply: verified("success") }]);
    const payment = await new Paystack({ secretKey: SECRET, fetch }).verify("order-1");
    expect(payment).toMatchObject({ status: "success", amount: 1050, currency: "GHS", providerTransactionId: "42" });
    expect(payment.paidAt).toEqual(new Date("2026-10-31T10:00:00.000Z"));
  });

  it("turns API errors into PesewaErrors", async () => {
    const { fetch } = mockFetch([
      { method: "GET", match: "/transaction/verify/missing", reply: { status: 404, body: { status: false, message: "Transaction reference not found" } } },
      { method: "POST", match: "/charge", reply: { status: 401, body: { status: false, message: "Invalid key" } } },
    ]);
    const paystack = new Paystack({ secretKey: SECRET, fetch });
    await expect(paystack.verify("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(paystack.collect({ amount: 100, phone: "0241234567", reference: "r", email: "a@b.co" })).rejects.toMatchObject({
      code: "authentication",
    });
  });

  describe("webhooks", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "order-1", status: "success" } });

    it("accepts a correctly signed event and confirms it with the API", async () => {
      const { fetch, calls } = mockFetch([{ method: "GET", match: "/transaction/verify/order-1", reply: verified("success") }]);
      const payment = await new Paystack({ secretKey: SECRET, fetch }).handleWebhook({
        body,
        headers: { "X-Paystack-Signature": sign(body) },
      });
      expect(payment).toMatchObject({ status: "success", reference: "order-1" });
      expect(calls).toHaveLength(1); // confirmed with verify(), not trusted from the body
    });

    it("rejects a forged, tampered, or missing signature without calling the API", async () => {
      const { fetch, calls } = mockFetch([]);
      const paystack = new Paystack({ secretKey: SECRET, fetch });
      const tampered = body.replace("order-1", "order-9");
      for (const headers of [{ "x-paystack-signature": "deadbeef" }, { "x-paystack-signature": sign(body) }, {}]) {
        const request = headers["x-paystack-signature"] === sign(body) ? { body: tampered, headers } : { body, headers };
        await expect(paystack.handleWebhook(request)).rejects.toMatchObject({ code: "invalid_webhook" });
      }
      expect(calls).toHaveLength(0);
    });

    it("ignores events that aren't charges", async () => {
      const other = JSON.stringify({ event: "transfer.success", data: { reference: "t-1" } });
      const result = await new Paystack({ secretKey: SECRET, fetch: mockFetch([]).fetch }).handleWebhook({
        body: other,
        headers: new Headers({ "x-paystack-signature": sign(other) }),
      });
      expect(result).toBeNull();
    });
  });

  it("initialises a hosted checkout and issues refunds", async () => {
    const { fetch, calls } = mockFetch([
      { method: "POST", match: "/transaction/initialize", reply: { body: { status: true, data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "abc", reference: "order-3" } } } },
      { method: "POST", match: "/refund", reply: { body: { status: true, data: { id: 7, status: "pending" } } } },
    ]);
    const paystack = new Paystack({ secretKey: SECRET, fetch });

    const checkout = await paystack.initializeCheckout({ amount: 2000, email: "a@b.co", reference: "order-3", callbackUrl: "https://shop.example/done" });
    expect(checkout.authorizationUrl).toBe("https://checkout.paystack.com/abc");
    expect(calls[0].body).toMatchObject({ amount: 2000, currency: "GHS", callback_url: "https://shop.example/done" });

    expect(await paystack.refund({ reference: "order-3", amount: 500 })).toMatchObject({ id: "7", status: "pending" });
    expect(calls[1].body).toMatchObject({ transaction: "order-3", amount: 500 });
  });
});
