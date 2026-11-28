import { randomUUID } from "node:crypto";
import { PesewaError } from "../errors";
import { asRecord, request, type HttpOptions } from "../http";
import { assertMinorUnits, fromMajor, toMajorString } from "../money";
import { normalizeGhanaPhone, resolveNetwork } from "../phone";
import type {
  CollectRequest,
  CollectResult,
  MobileMoneyProvider,
  Payment,
  Payout,
  PayoutProvider,
  PayoutRequest,
  PayoutResult,
  ProviderOptions,
  WebhookRequest,
} from "../types";

const SANDBOX_URL = "https://sandbox.momodeveloper.mtn.com";
const REF_PARAM = "pesewa_ref";
// Collections and payouts share one callback URL; this marks payout callbacks
const KIND_PARAM = "pesewa_kind";

type Product = "collection" | "disbursement";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MtnMomoOptions = ProviderOptions & {
  /** Collections product subscription key (Ocp-Apim-Subscription-Key). */
  subscriptionKey: string;
  /** API user id (a UUID) and its API key. */
  apiUser: string;
  apiKey: string;
  /** "sandbox", or the production target environment MTN gives you at onboarding (e.g. "mtnghana"). */
  environment: string;
  /** Required in production: the API host from your MTN onboarding. Defaults to the sandbox host. */
  baseUrl?: string;
  /**
   * Where MTN should notify you. The reference is appended as `?pesewa_ref=`,
   * because MTN's callback body doesn't include it. The host must match the
   * callback host registered for your API user.
   */
  callbackUrl?: string;
  /**
   * For payouts: the Disbursement product's own subscription key and API
   * user. MTN issues these separately from the Collections ones.
   */
  disbursement?: { subscriptionKey: string; apiUser: string; apiKey: string };
};

/**
 * MTN MoMo Collections (Request to Pay). MTN's callbacks aren't signed, so
 * `handleWebhook()` treats them only as a signal and confirms every payment
 * with MTN's status endpoint.
 */
export class MtnMomo implements MobileMoneyProvider, PayoutProvider {
  readonly name = "mtn_momo";
  private readonly baseUrl: string;
  private readonly tokens: Partial<Record<Product, { value: string; expiresAt: number }>> = {};

  constructor(private readonly options: MtnMomoOptions) {
    for (const key of ["subscriptionKey", "apiUser", "apiKey", "environment"] as const) {
      if (!options[key]) throw new PesewaError("invalid_request", `MTN MoMo: ${key} is required`);
    }
    if (options.environment !== "sandbox" && !options.baseUrl) {
      throw new PesewaError("invalid_request", "MTN MoMo: baseUrl is required outside the sandbox (use the host from your MTN onboarding)");
    }
    if (options.disbursement) {
      for (const key of ["subscriptionKey", "apiUser", "apiKey"] as const) {
        if (!options.disbursement[key]) throw new PesewaError("invalid_request", `MTN MoMo: disbursement.${key} is required`);
      }
    }
    this.baseUrl = (options.baseUrl ?? SANDBOX_URL).replace(/\/$/, "");
  }

  private credentials(product: Product): { subscriptionKey: string; apiUser: string; apiKey: string } {
    if (product === "collection") return this.options;
    if (!this.options.disbursement) {
      throw new PesewaError("unsupported", "MTN MoMo: payouts need the Disbursement product; pass `disbursement` keys", { provider: this.name });
    }
    return this.options.disbursement;
  }

  private callback(referenceId: string, kind?: "payout"): string | undefined {
    if (!this.options.callbackUrl) return undefined;
    const url = new URL(this.options.callbackUrl);
    url.searchParams.set(REF_PARAM, referenceId);
    if (kind) url.searchParams.set(KIND_PARAM, kind);
    return url.toString();
  }

  /** Gets an access token for a product, reusing it until a minute before it expires. */
  private async accessToken(product: Product): Promise<string> {
    const cached = this.tokens[product];
    if (cached && Date.now() < cached.expiresAt) return cached.value;
    const creds = this.credentials(product);
    const basic = Buffer.from(`${creds.apiUser}:${creds.apiKey}`).toString("base64");
    const res = await request(this.name, this.options, `${this.baseUrl}/${product}/token/`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Ocp-Apim-Subscription-Key": creds.subscriptionKey },
    });
    const data = asRecord(res.data);
    if (res.status !== 200 || typeof data.access_token !== "string") {
      throw new PesewaError("authentication", "MTN MoMo: couldn't get an access token", { provider: this.name, httpStatus: res.status, raw: res.data });
    }
    const ttlSeconds = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.tokens[product] = { value: data.access_token, expiresAt: Date.now() + Math.max(ttlSeconds - 60, 0) * 1000 };
    return data.access_token;
  }

  private async headers(product: Product, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.accessToken(product)}`,
      "X-Target-Environment": this.options.environment,
      "Ocp-Apim-Subscription-Key": this.credentials(product).subscriptionKey,
      ...extra,
    };
  }

  async collect(req: CollectRequest): Promise<CollectResult> {
    assertMinorUnits(req.amount);
    if (resolveNetwork(req.phone, req.network) !== "mtn") {
      throw new PesewaError("invalid_request", "MTN MoMo can only collect from MTN numbers");
    }
    // MTN needs a UUID v4 as the X-Reference-Id. Reuse the caller's reference when
    // it is one, so they know the id before the request is sent: a callback can
    // arrive before collect() returns, and they'll already have it on record.
    const referenceId = UUID_V4.test(req.reference) ? req.reference.toLowerCase() : randomUUID();
    const extra: Record<string, string> = { "X-Reference-Id": referenceId };
    const callbackUrl = this.callback(referenceId);
    if (callbackUrl) extra["X-Callback-Url"] = callbackUrl;

    const res = await request(this.name, this.options, `${this.baseUrl}/collection/v1_0/requesttopay`, {
      method: "POST",
      headers: await this.headers("collection", extra),
      body: {
        amount: toMajorString(req.amount),
        currency: req.currency ?? "GHS",
        externalId: req.reference,
        payer: { partyIdType: "MSISDN", partyId: normalizeGhanaPhone(req.phone).msisdn },
        payerMessage: req.description ?? "",
        payeeNote: req.description ?? "",
      },
    });
    if (res.status === 409) {
      throw new PesewaError("duplicate_reference", "MTN MoMo: duplicate X-Reference-Id", { provider: this.name, httpStatus: 409, raw: res.data });
    }
    if (res.status !== 202) {
      const message = asRecord(res.data).message;
      throw new PesewaError("provider_error", `MTN MoMo: ${typeof message === "string" ? message : `request failed (HTTP ${res.status})`}`, {
        provider: this.name,
        httpStatus: res.status,
        raw: res.data,
      });
    }
    // 202 Accepted: the payer gets a prompt on their phone
    return { provider: this.name, status: "pending", reference: referenceId, raw: res.data };
  }

  submitOtp(): Promise<CollectResult> {
    return Promise.reject(new PesewaError("unsupported", "MTN MoMo collections are approved on the payer's phone; there's no OTP step"));
  }

  /** Looks up a Request to Pay by the reference `collect()` returned (MTN's X-Reference-Id). */
  async verify(reference: string): Promise<Payment> {
    const res = await request(this.name, this.options, `${this.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: await this.headers("collection"),
    });
    if (res.status === 404) throw new PesewaError("not_found", `MTN MoMo: no request to pay ${reference}`, { provider: this.name, httpStatus: 404 });
    if (res.status !== 200) {
      throw new PesewaError("provider_error", `MTN MoMo: status check failed (HTTP ${res.status})`, { provider: this.name, httpStatus: res.status, raw: res.data });
    }

    const data = asRecord(res.data);
    const status = data.status === "SUCCESSFUL" ? "success" : data.status === "PENDING" ? "pending" : "failed";
    const reason = asRecord(data.reason).message ?? data.reason;
    return {
      provider: this.name,
      reference,
      status,
      amount: data.amount !== undefined ? fromMajor(String(data.amount)) : undefined,
      currency: typeof data.currency === "string" ? data.currency : undefined,
      providerTransactionId: typeof data.financialTransactionId === "string" ? data.financialTransactionId : undefined,
      failureReason: status === "failed" && typeof reason === "string" ? reason : undefined,
      raw: data,
    };
  }

  private callbackReference(req: WebhookRequest): { reference: string; kind: string | null } {
    if (!req.url) throw new PesewaError("invalid_request", "MTN MoMo: pass the request url to handleWebhook()");
    const params = new URL(req.url, "http://localhost").searchParams;
    const reference = params.get(REF_PARAM);
    if (!reference || !/^[0-9a-f-]{36}$/i.test(reference)) {
      throw new PesewaError("invalid_webhook", `MTN MoMo: callback URL has no valid ${REF_PARAM}`, { provider: this.name });
    }
    return { reference, kind: params.get(KIND_PARAM) };
  }

  /** Reads the reference from the callback URL and confirms the payment with MTN. Payout callbacks return null. */
  async handleWebhook(req: WebhookRequest): Promise<Payment | null> {
    const { reference, kind } = this.callbackReference(req);
    return kind === "payout" ? null : this.verify(reference);
  }

  // ---- Payouts (Disbursement: Transfer) ---------------------------------------

  /**
   * Sends money to an MTN wallet. The reference must be a UUID v4: it becomes
   * MTN's X-Reference-Id, so retrying with the same reference can't pay twice
   * (MTN answers 409 instead).
   */
  async payout(req: PayoutRequest): Promise<PayoutResult> {
    assertMinorUnits(req.amount);
    if (!UUID_V4.test(req.reference)) {
      throw new PesewaError("invalid_request", "MTN MoMo: payout references must be a UUID v4, so a retry can't pay twice");
    }
    if (resolveNetwork(req.phone, req.network) !== "mtn") {
      throw new PesewaError("invalid_request", "MTN MoMo can only pay out to MTN numbers");
    }
    const referenceId = req.reference.toLowerCase();
    const extra: Record<string, string> = { "X-Reference-Id": referenceId };
    const callbackUrl = this.callback(referenceId, "payout");
    if (callbackUrl) extra["X-Callback-Url"] = callbackUrl;

    const res = await request(this.name, this.options, `${this.baseUrl}/disbursement/v1_0/transfer`, {
      method: "POST",
      headers: await this.headers("disbursement", extra),
      body: {
        amount: toMajorString(req.amount),
        currency: req.currency ?? "GHS",
        externalId: referenceId,
        payee: { partyIdType: "MSISDN", partyId: normalizeGhanaPhone(req.phone).msisdn },
        payerMessage: req.reason ?? "",
        payeeNote: req.reason ?? "",
      },
    });
    if (res.status === 409) {
      throw new PesewaError("duplicate_reference", "MTN MoMo: duplicate X-Reference-Id", { provider: this.name, httpStatus: 409, raw: res.data });
    }
    if (res.status !== 202) {
      const message = asRecord(res.data).message;
      throw new PesewaError("provider_error", `MTN MoMo: ${typeof message === "string" ? message : `payout failed (HTTP ${res.status})`}`, {
        provider: this.name,
        httpStatus: res.status,
        raw: res.data,
      });
    }
    return { provider: this.name, status: "pending", reference: referenceId, raw: res.data };
  }

  async verifyPayout(reference: string): Promise<Payout> {
    const res = await request(this.name, this.options, `${this.baseUrl}/disbursement/v1_0/transfer/${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: await this.headers("disbursement"),
    });
    if (res.status === 404) throw new PesewaError("not_found", `MTN MoMo: no transfer ${reference}`, { provider: this.name, httpStatus: 404 });
    if (res.status !== 200) {
      throw new PesewaError("provider_error", `MTN MoMo: transfer status check failed (HTTP ${res.status})`, {
        provider: this.name,
        httpStatus: res.status,
        raw: res.data,
      });
    }
    const data = asRecord(res.data);
    const status = data.status === "SUCCESSFUL" ? "success" : data.status === "PENDING" ? "pending" : "failed";
    const reason = asRecord(data.reason).message ?? data.reason;
    return {
      provider: this.name,
      reference,
      status,
      amount: data.amount !== undefined ? fromMajor(String(data.amount)) : undefined,
      currency: typeof data.currency === "string" ? data.currency : undefined,
      providerTransactionId: typeof data.financialTransactionId === "string" ? data.financialTransactionId : undefined,
      failureReason: status === "failed" && typeof reason === "string" ? reason : undefined,
      raw: data,
    };
  }

  /** Payout callbacks (marked in the callback URL), confirmed with MTN. Collection callbacks return null. */
  async handlePayoutWebhook(req: WebhookRequest): Promise<Payout | null> {
    const { reference, kind } = this.callbackReference(req);
    return kind === "payout" ? this.verifyPayout(reference) : null;
  }

  /**
   * Sandbox only: creates an API user and key for testing. In production, MTN
   * provisions these through its partner portal.
   */
  static async createSandboxUser(input: { subscriptionKey: string; callbackHost: string } & HttpOptions): Promise<{ apiUser: string; apiKey: string }> {
    const apiUser = randomUUID();
    const headers = { "Ocp-Apim-Subscription-Key": input.subscriptionKey };
    const created = await request("mtn_momo", input, `${SANDBOX_URL}/v1_0/apiuser`, {
      method: "POST",
      headers: { ...headers, "X-Reference-Id": apiUser },
      body: { providerCallbackHost: input.callbackHost },
    });
    if (created.status !== 201) {
      throw new PesewaError("provider_error", `MTN MoMo: couldn't create sandbox user (HTTP ${created.status})`, { provider: "mtn_momo", raw: created.data });
    }
    const keyRes = await request("mtn_momo", input, `${SANDBOX_URL}/v1_0/apiuser/${apiUser}/apikey`, { method: "POST", headers });
    const apiKey = asRecord(keyRes.data).apiKey;
    if (keyRes.status !== 201 || typeof apiKey !== "string") {
      throw new PesewaError("provider_error", `MTN MoMo: couldn't create sandbox API key (HTTP ${keyRes.status})`, { provider: "mtn_momo", raw: keyRes.data });
    }
    return { apiUser, apiKey };
  }
}
