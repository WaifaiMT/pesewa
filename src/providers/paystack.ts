import { hmacSha512Hex, safeEqual } from "../crypto";
import { PesewaError } from "../errors";
import { asRecord, getHeader, request, type HttpResponse } from "../http";
import { assertMinorUnits } from "../money";
import { normalizeGhanaPhone, resolveNetwork, type Network } from "../phone";
import type { CollectRequest, CollectResult, CollectStatus, MobileMoneyProvider, Payment, ProviderOptions, WebhookRequest } from "../types";

export type PaystackOptions = ProviderOptions & {
  /** Secret key (sk_test_... or sk_live_...). Server-side only. Also used to verify webhook signatures. */
  secretKey: string;
  /**
   * Paystack requires an email for every charge. When a request has none,
   * use `<msisdn>@<fallbackEmailDomain>` instead of failing.
   */
  fallbackEmailDomain?: string;
  /**
   * Paystack's mobile money provider codes. The defaults are the documented
   * Ghana codes; check yours with `listMobileMoneyProviders()`.
   */
  providerCodes?: Partial<Record<Network, string>>;
  /** Default https://api.paystack.co */
  baseUrl?: string;
};

const DEFAULT_PROVIDER_CODES: Record<Network, string> = { mtn: "mtn", telecel: "vod", at: "atl" };

// Paystack charge statuses. Ghana mobile money usually returns pay_offline
// (approve the prompt on the phone) or send_otp.
function toCollectStatus(status: unknown): CollectStatus {
  switch (status) {
    case "success":
      return "success";
    case "send_otp":
      return "otp_required";
    case "failed":
    case "abandoned":
    case "reversed":
      return "failed";
    default:
      return "pending"; // pay_offline, pending, ongoing, processing, queued
  }
}

export class Paystack implements MobileMoneyProvider {
  readonly name = "paystack";
  private readonly baseUrl: string;
  private readonly codes: Record<Network, string>;

  constructor(private readonly options: PaystackOptions) {
    if (!options.secretKey) throw new PesewaError("invalid_request", "Paystack: secretKey is required");
    this.baseUrl = (options.baseUrl ?? "https://api.paystack.co").replace(/\/$/, "");
    this.codes = { ...DEFAULT_PROVIDER_CODES, ...options.providerCodes };
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await request(this.name, this.options, `${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.secretKey}` },
      body,
    });
    return this.unwrap(response);
  }

  private unwrap({ status, data }: HttpResponse): Record<string, unknown> {
    const body = asRecord(data);
    if (status >= 200 && status < 300 && body.status === true) return asRecord(body.data);
    const message = typeof body.message === "string" ? body.message : `HTTP ${status}`;
    const code = status === 404 ? "not_found" : /duplicate/i.test(message) ? "duplicate_reference" : "provider_error";
    throw new PesewaError(code, `Paystack: ${message}`, { provider: this.name, httpStatus: status, raw: data });
  }

  private email(req: CollectRequest): string {
    if (req.email) return req.email;
    if (this.options.fallbackEmailDomain) return `${normalizeGhanaPhone(req.phone).msisdn}@${this.options.fallbackEmailDomain}`;
    throw new PesewaError("invalid_request", "Paystack requires an email; pass `email` or set `fallbackEmailDomain`.");
  }

  private toResult(reference: string, data: Record<string, unknown>): CollectResult {
    const message = [data.display_text, data.message, data.gateway_response].find((m) => typeof m === "string" && m) as
      | string
      | undefined;
    return { provider: this.name, status: toCollectStatus(data.status), reference, message, raw: data };
  }

  async collect(req: CollectRequest): Promise<CollectResult> {
    assertMinorUnits(req.amount);
    const phone = normalizeGhanaPhone(req.phone);
    const network = resolveNetwork(req.phone, req.network);
    const data = await this.call("POST", "/charge", {
      email: this.email(req),
      amount: req.amount, // Paystack takes minor units (pesewas)
      currency: req.currency ?? "GHS",
      reference: req.reference,
      mobile_money: { phone: phone.local, provider: this.codes[network] },
      metadata: req.metadata,
    });
    return this.toResult(req.reference, data);
  }

  async submitOtp(req: CollectRequest, otp: string): Promise<CollectResult> {
    const data = await this.call("POST", "/charge/submit_otp", { otp, reference: req.reference });
    return this.toResult(req.reference, data);
  }

  async verify(reference: string): Promise<Payment> {
    const data = await this.call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    const status = data.status === "success" ? "success" : ["failed", "abandoned", "reversed"].includes(String(data.status)) ? "failed" : "pending";
    return {
      provider: this.name,
      reference,
      status,
      amount: typeof data.amount === "number" ? data.amount : undefined,
      currency: typeof data.currency === "string" ? data.currency : undefined,
      providerTransactionId: data.id !== undefined ? String(data.id) : undefined,
      paidAt: typeof data.paid_at === "string" ? new Date(data.paid_at) : undefined,
      failureReason: status === "failed" && typeof data.gateway_response === "string" ? data.gateway_response : undefined,
      raw: data,
    };
  }

  /**
   * Checks the `x-paystack-signature` header (HMAC-SHA512 of the raw body
   * with your secret key), then confirms the transaction with `verify()`.
   */
  async handleWebhook(req: WebhookRequest): Promise<Payment | null> {
    const signature = getHeader(req.headers, "x-paystack-signature");
    if (!signature || !safeEqual(signature, hmacSha512Hex(this.options.secretKey, req.body))) {
      throw new PesewaError("invalid_webhook", "Paystack: webhook signature is missing or invalid", { provider: this.name });
    }

    let event: Record<string, unknown>;
    try {
      event = asRecord(JSON.parse(req.body));
    } catch {
      throw new PesewaError("invalid_webhook", "Paystack: webhook body isn't JSON", { provider: this.name });
    }
    if (typeof event.event !== "string" || !event.event.startsWith("charge.")) return null;
    const reference = asRecord(event.data).reference;
    if (typeof reference !== "string") return null;
    return this.verify(reference);
  }

  /** Creates a Paystack-hosted checkout page (cards, mobile money, bank) and returns its URL. */
  async initializeCheckout(input: {
    amount: number;
    email: string;
    reference: string;
    currency?: string;
    callbackUrl?: string;
    channels?: ("card" | "bank" | "mobile_money" | "ussd" | "qr" | "bank_transfer")[];
    metadata?: Record<string, unknown>;
  }): Promise<{ authorizationUrl: string; accessCode: string; reference: string }> {
    assertMinorUnits(input.amount);
    const data = await this.call("POST", "/transaction/initialize", {
      email: input.email,
      amount: input.amount,
      currency: input.currency ?? "GHS",
      reference: input.reference,
      callback_url: input.callbackUrl,
      channels: input.channels,
      metadata: input.metadata,
    });
    return {
      authorizationUrl: String(data.authorization_url),
      accessCode: String(data.access_code),
      reference: String(data.reference),
    };
  }

  /** Refunds a successful transaction, fully or partly (amount in minor units). */
  async refund(input: { reference: string; amount?: number; reason?: string }): Promise<{ id: string; status: string; raw: unknown }> {
    if (input.amount !== undefined) assertMinorUnits(input.amount);
    const data = await this.call("POST", "/refund", {
      transaction: input.reference,
      amount: input.amount,
      merchant_note: input.reason,
    });
    return { id: String(data.id), status: String(data.status), raw: data };
  }

  /** Paystack's current mobile money providers and their codes for a country (default Ghana). */
  async listMobileMoneyProviders(country = "ghana"): Promise<{ name: string; code: string }[]> {
    const response = await request(this.name, this.options, `${this.baseUrl}/bank?country=${encodeURIComponent(country)}&type=mobile_money`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.options.secretKey}` },
    });
    const body = asRecord(response.data);
    if (response.status !== 200 || body.status !== true || !Array.isArray(body.data)) {
      throw new PesewaError("provider_error", "Paystack: couldn't list mobile money providers", { provider: this.name, raw: response.data });
    }
    return body.data.map((b) => ({ name: String(asRecord(b).name), code: String(asRecord(b).code) }));
  }
}
