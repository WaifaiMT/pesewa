import { safeEqual } from "../crypto";
import { PesewaError } from "../errors";
import { asRecord, request } from "../http";
import { assertMinorUnits, fromMajor, toMajorString } from "../money";
import { normalizeGhanaPhone, resolveNetwork, type Network } from "../phone";
import type { CollectRequest, CollectResult, MobileMoneyProvider, Payment, ProviderOptions, WebhookRequest } from "../types";

export type MoolreOptions = ProviderOptions & {
  /** Your Moolre username (sent as X-API-USER). */
  apiUser: string;
  /** Your public API key (sent as X-API-PUBKEY for collections and status checks). */
  publicKey: string;
  /** Your Moolre wallet account number that receives the money. */
  accountNumber: string;
  /** The callback secret Moolre includes in each webhook's `data.secret`. Required for `handleWebhook()`. */
  callbackSecret?: string;
  /** Use https://sandbox.moolre.com instead of live. */
  sandbox?: boolean;
  /** In the sandbox only: skip the simulated OTP step. */
  skipOtpInSandbox?: boolean;
  baseUrl?: string;
};

// Moolre's channel codes for mobile money collections
const COLLECTION_CHANNEL: Record<Network, string> = { mtn: "13", telecel: "6", at: "7" };

export class Moolre implements MobileMoneyProvider {
  readonly name = "moolre";
  private readonly baseUrl: string;

  constructor(private readonly options: MoolreOptions) {
    for (const key of ["apiUser", "publicKey", "accountNumber"] as const) {
      if (!options[key]) throw new PesewaError("invalid_request", `Moolre: ${key} is required`);
    }
    this.baseUrl = (options.baseUrl ?? (options.sandbox ? "https://sandbox.moolre.com" : "https://api.moolre.com")).replace(/\/$/, "");
  }

  private async post(path: string, body: Record<string, unknown>) {
    const response = await request(this.name, this.options, `${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "X-API-USER": this.options.apiUser, "X-API-PUBKEY": this.options.publicKey },
      body,
    });
    const data = asRecord(response.data);
    // Moolre sends status as 1 or "0" depending on the response; normalise it
    return { httpStatus: response.status, ok: Number(data.status) === 1, code: String(data.code ?? ""), message: data.message, data };
  }

  private async pay(req: CollectRequest, otp?: string): Promise<CollectResult> {
    assertMinorUnits(req.amount);
    const network = resolveNetwork(req.phone, req.network);
    const res = await this.post("/open/transact/payment", {
      type: 1,
      channel: COLLECTION_CHANNEL[network],
      currency: req.currency ?? "GHS",
      payer: normalizeGhanaPhone(req.phone).local,
      amount: toMajorString(req.amount), // Moolre takes a decimal string in cedis
      externalref: req.reference,
      accountnumber: this.options.accountNumber,
      ...(otp ? { otpcode: otp } : {}),
      ...(req.description ? { reference: req.description } : {}),
      ...(this.options.sandbox && this.options.skipOtpInSandbox ? { skipotp: true } : {}),
    });
    const message = typeof res.message === "string" ? res.message : undefined;
    const result = (status: CollectResult["status"]): CollectResult => ({
      provider: this.name,
      status,
      reference: req.reference,
      message,
      raw: res.data,
    });

    switch (res.code) {
      case "TR099": // prompt sent to the payer's phone
      case "TP17": // phone verified
        return result("pending");
      case "TP14": // payer must verify with the OTP sent by SMS, then retry with it
        return result("otp_required");
      case "TP13":
        throw new PesewaError("duplicate_reference", `Moolre: ${message ?? "external reference must be unique"}`, {
          provider: this.name,
          providerCode: res.code,
          raw: res.data,
        });
      default:
        throw new PesewaError("provider_error", `Moolre: ${message ?? `request failed (${res.code || res.httpStatus})`}`, {
          provider: this.name,
          httpStatus: res.httpStatus,
          providerCode: res.code,
          raw: res.data,
        });
    }
  }

  collect(req: CollectRequest): Promise<CollectResult> {
    return this.pay(req);
  }

  /** Moolre's OTP step resubmits the same payment with the code. */
  submitOtp(req: CollectRequest, otp: string): Promise<CollectResult> {
    if (!otp) throw new PesewaError("invalid_request", "Moolre: otp is required");
    return this.pay(req, otp);
  }

  async verify(reference: string): Promise<Payment> {
    const res = await this.post("/open/transact/status", {
      type: 1,
      idtype: 1, // look up by our externalref
      id: reference,
      accountnumber: this.options.accountNumber,
    });
    if (!res.ok) {
      throw new PesewaError("provider_error", `Moolre: ${typeof res.message === "string" ? res.message : "status check failed"}`, {
        provider: this.name,
        providerCode: res.code,
        raw: res.data,
      });
    }
    return this.toPayment(reference, asRecord(res.data.data), res.data);
  }

  private toPayment(reference: string, tx: Record<string, unknown>, raw: unknown): Payment {
    // txstatus: 1 = successful, 0 = pending, 2 = failed
    const txstatus = Number(tx.txstatus);
    const status = txstatus === 1 ? "success" : txstatus === 2 ? "failed" : "pending";
    const amount = tx.amount !== undefined && tx.amount !== "" ? fromMajor(String(tx.amount)) : undefined;
    return {
      provider: this.name,
      reference,
      status,
      amount: amount || undefined,
      providerTransactionId: typeof tx.transactionid === "string" ? tx.transactionid : undefined,
      failureReason: status === "failed" && typeof tx.reason === "string" ? tx.reason : undefined,
      raw,
    };
  }

  /**
   * Checks the callback's `data.secret` against your callback secret
   * (constant-time), then confirms the payment with `verify()`.
   */
  async handleWebhook(req: WebhookRequest): Promise<Payment | null> {
    const secret = this.options.callbackSecret;
    if (!secret) throw new PesewaError("invalid_request", "Moolre: set callbackSecret to handle webhooks");

    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(req.body));
    } catch {
      throw new PesewaError("invalid_webhook", "Moolre: webhook body isn't JSON", { provider: this.name });
    }
    const data = asRecord(body.data);
    if (typeof data.secret !== "string" || !safeEqual(data.secret, secret)) {
      throw new PesewaError("invalid_webhook", "Moolre: webhook secret is missing or wrong", { provider: this.name });
    }
    if (typeof data.externalref !== "string" || !data.externalref) return null;
    return this.verify(data.externalref);
  }
}
