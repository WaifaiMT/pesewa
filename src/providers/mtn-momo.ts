import { randomUUID } from "node:crypto";
import { PesewaError } from "../errors";
import { asRecord, request, type HttpOptions } from "../http";
import { assertMinorUnits, fromMajor, toMajorString } from "../money";
import { normalizeGhanaPhone, resolveNetwork } from "../phone";
import type { CollectRequest, CollectResult, MobileMoneyProvider, Payment, ProviderOptions, WebhookRequest } from "../types";

const SANDBOX_URL = "https://sandbox.momodeveloper.mtn.com";
const REF_PARAM = "pesewa_ref";

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
};

/**
 * MTN MoMo Collections (Request to Pay). MTN's callbacks aren't signed, so
 * `handleWebhook()` treats them only as a signal and confirms every payment
 * with MTN's status endpoint.
 */
export class MtnMomo implements MobileMoneyProvider {
  readonly name = "mtn_momo";
  private readonly baseUrl: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: MtnMomoOptions) {
    for (const key of ["subscriptionKey", "apiUser", "apiKey", "environment"] as const) {
      if (!options[key]) throw new PesewaError("invalid_request", `MTN MoMo: ${key} is required`);
    }
    if (options.environment !== "sandbox" && !options.baseUrl) {
      throw new PesewaError("invalid_request", "MTN MoMo: baseUrl is required outside the sandbox (use the host from your MTN onboarding)");
    }
    this.baseUrl = (options.baseUrl ?? SANDBOX_URL).replace(/\/$/, "");
  }

  /** Gets an access token, reusing it until a minute before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.options.apiUser}:${this.options.apiKey}`).toString("base64");
    const res = await request(this.name, this.options, `${this.baseUrl}/collection/token/`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Ocp-Apim-Subscription-Key": this.options.subscriptionKey },
    });
    const data = asRecord(res.data);
    if (res.status !== 200 || typeof data.access_token !== "string") {
      throw new PesewaError("authentication", "MTN MoMo: couldn't get an access token", { provider: this.name, httpStatus: res.status, raw: res.data });
    }
    const ttlSeconds = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.token = { value: data.access_token, expiresAt: Date.now() + Math.max(ttlSeconds - 60, 0) * 1000 };
    return this.token.value;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.accessToken()}`,
      "X-Target-Environment": this.options.environment,
      "Ocp-Apim-Subscription-Key": this.options.subscriptionKey,
      ...extra,
    };
  }

  async collect(req: CollectRequest): Promise<CollectResult> {
    assertMinorUnits(req.amount);
    if (resolveNetwork(req.phone, req.network) !== "mtn") {
      throw new PesewaError("invalid_request", "MTN MoMo can only collect from MTN numbers");
    }
    const referenceId = randomUUID();
    const extra: Record<string, string> = { "X-Reference-Id": referenceId };
    if (this.options.callbackUrl) {
      const url = new URL(this.options.callbackUrl);
      url.searchParams.set(REF_PARAM, referenceId);
      extra["X-Callback-Url"] = url.toString();
    }

    const res = await request(this.name, this.options, `${this.baseUrl}/collection/v1_0/requesttopay`, {
      method: "POST",
      headers: await this.headers(extra),
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
      headers: await this.headers(),
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

  /** Reads the reference from the callback URL and confirms the payment with MTN. */
  async handleWebhook(req: WebhookRequest): Promise<Payment | null> {
    if (!req.url) throw new PesewaError("invalid_request", "MTN MoMo: pass the request url to handleWebhook()");
    const reference = new URL(req.url, "http://localhost").searchParams.get(REF_PARAM);
    if (!reference || !/^[0-9a-f-]{36}$/i.test(reference)) {
      throw new PesewaError("invalid_webhook", `MTN MoMo: callback URL has no valid ${REF_PARAM}`, { provider: this.name });
    }
    return this.verify(reference);
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
