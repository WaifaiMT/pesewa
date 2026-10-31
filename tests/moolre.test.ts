import { describe, expect, it } from "vitest";
import { Moolre } from "../src";
import { mockFetch } from "./mock-fetch";

const base = { apiUser: "shop", publicKey: "pub_123", accountNumber: "10001", callbackSecret: "cb-secret" };
const statusReply = (txstatus: number) => ({
  body: { status: 1, code: "SS01", message: "Transaction Successful", data: { txstatus, amount: "10.50", transactionid: "mt-9", externalref: "order-1" } },
});

describe("Moolre", () => {
  it("sends a collection with Moolre's channel code, local phone, and decimal amount", async () => {
    const { fetch, calls } = mockFetch([
      { method: "POST", match: "/open/transact/payment", reply: { body: { status: 1, code: "TR099", message: null, data: "uuid" } } },
    ]);
    const result = await new Moolre({ ...base, fetch }).collect({ amount: 1050, phone: "+233541234567", reference: "order-1" });

    expect(result).toMatchObject({ status: "pending", reference: "order-1" });
    expect(calls[0].url).toBe("https://api.moolre.com/open/transact/payment");
    expect(calls[0].headers).toMatchObject({ "X-API-USER": "shop", "X-API-PUBKEY": "pub_123" });
    expect(calls[0].body).toEqual({
      type: 1,
      channel: "13",
      currency: "GHS",
      payer: "0541234567",
      amount: "10.50",
      externalref: "order-1",
      accountnumber: "10001",
    });
  });

  it("handles the two-step OTP flow", async () => {
    let attempt = 0;
    const { fetch, calls } = mockFetch([
      {
        method: "POST",
        match: "/open/transact/payment",
        reply: () => (attempt++ === 0 ? { body: { status: 1, code: "TP14", message: "Please complete the verification", data: "all" } } : { body: { status: 1, code: "TR099", data: "uuid" } }),
      },
    ]);
    const moolre = new Moolre({ ...base, fetch });
    const req = { amount: 200, phone: "0201234567", reference: "order-2" };

    expect((await moolre.collect(req)).status).toBe("otp_required");
    expect(calls[0].body).toMatchObject({ channel: "6" });
    expect((await moolre.submitOtp(req, "4321")).status).toBe("pending");
    expect(calls[1].body).toMatchObject({ otpcode: "4321", externalref: "order-2" });
  });

  it("reports duplicate references and other failures", async () => {
    const { fetch } = mockFetch([
      { method: "POST", match: "/open/transact/payment", reply: { status: 400, body: { status: "0", code: "TP13", message: "External reference is required and must be unique.", data: "externalref" } } },
    ]);
    await expect(new Moolre({ ...base, fetch }).collect({ amount: 100, phone: "0241234567", reference: "dup" })).rejects.toMatchObject({
      code: "duplicate_reference",
      details: { providerCode: "TP13" },
    });
  });

  it.each([
    [1, "success"],
    [0, "pending"],
    [2, "failed"],
  ])("maps txstatus %s to %s", async (txstatus, status) => {
    const { fetch, calls } = mockFetch([{ method: "POST", match: "/open/transact/status", reply: statusReply(txstatus) }]);
    const payment = await new Moolre({ ...base, fetch }).verify("order-1");
    expect(payment).toMatchObject({ status, reference: "order-1" });
    expect(calls[0].body).toEqual({ type: 1, idtype: 1, id: "order-1", accountnumber: "10001" });
    if (status === "success") expect(payment).toMatchObject({ amount: 1050, providerTransactionId: "mt-9" });
  });

  it("uses the sandbox host and can skip the sandbox OTP", async () => {
    const { fetch, calls } = mockFetch([{ method: "POST", match: "/open/transact/payment", reply: { body: { status: 1, code: "TR099" } } }]);
    await new Moolre({ ...base, sandbox: true, skipOtpInSandbox: true, fetch }).collect({ amount: 100, phone: "0571234567", reference: "s-1" });
    expect(calls[0].url).toBe("https://sandbox.moolre.com/open/transact/payment");
    expect(calls[0].body).toMatchObject({ skipotp: true, channel: "7" });
  });

  describe("webhooks", () => {
    const callback = (secret: string) =>
      JSON.stringify({ status: 1, code: "P01", message: "Transaction Successful", data: { txstatus: 1, externalref: "order-1", secret } });

    it("checks the callback secret, then confirms with the status API", async () => {
      const { fetch, calls } = mockFetch([{ method: "POST", match: "/open/transact/status", reply: statusReply(1) }]);
      const payment = await new Moolre({ ...base, fetch }).handleWebhook({ body: callback("cb-secret"), headers: {} });
      expect(payment).toMatchObject({ status: "success", reference: "order-1" });
      expect(calls).toHaveLength(1);
    });

    it("rejects a wrong or missing secret without calling the API", async () => {
      const { fetch, calls } = mockFetch([]);
      const moolre = new Moolre({ ...base, fetch });
      await expect(moolre.handleWebhook({ body: callback("guess"), headers: {} })).rejects.toMatchObject({ code: "invalid_webhook" });
      await expect(moolre.handleWebhook({ body: JSON.stringify({ data: { externalref: "x" } }), headers: {} })).rejects.toMatchObject({
        code: "invalid_webhook",
      });
      expect(calls).toHaveLength(0);
    });

    it("refuses to handle webhooks without a configured secret", async () => {
      const moolre = new Moolre({ apiUser: "a", publicKey: "b", accountNumber: "c", fetch: mockFetch([]).fetch });
      await expect(moolre.handleWebhook({ body: callback("x"), headers: {} })).rejects.toMatchObject({ code: "invalid_request" });
    });
  });
});
