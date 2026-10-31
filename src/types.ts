import type { HttpOptions } from "./http";
import type { Network } from "./phone";

export type CollectRequest = {
  /** Integer amount in minor units: 1050 = GHS 10.50. */
  amount: number;
  /** ISO currency. Default "GHS". (MTN's sandbox only accepts "EUR".) */
  currency?: string;
  /** The payer's mobile number, in any common Ghana format. */
  phone: string;
  /** Your unique reference for this payment. Never reuse one. */
  reference: string;
  /** The payer's network. Detected from the number if omitted. */
  network?: Network;
  /** Payer email. Required by Paystack (or set `fallbackEmailDomain`). */
  email?: string;
  /** Short text shown to the payer where the provider supports it. */
  description?: string;
  metadata?: Record<string, unknown>;
};

/**
 * - `pending`: a prompt was sent to the payer's phone; wait for the webhook or poll `verify()`
 * - `otp_required`: ask the payer for the OTP they received, then call `submitOtp()`
 * - `success` / `failed`: final
 */
export type CollectStatus = "pending" | "otp_required" | "success" | "failed";

export type CollectResult = {
  provider: string;
  status: CollectStatus;
  /** The id to pass to `verify()`. Your reference for Paystack and Moolre; MTN's X-Reference-Id (a UUID) for MTN MoMo. */
  reference: string;
  message?: string;
  raw: unknown;
};

export type PaymentStatus = "success" | "pending" | "failed";

/** A payment's state, as confirmed with the provider's API. */
export type Payment = {
  provider: string;
  reference: string;
  status: PaymentStatus;
  /** Minor units, when the provider reports it. */
  amount?: number;
  currency?: string;
  /** The provider's own transaction id. */
  providerTransactionId?: string;
  paidAt?: Date;
  failureReason?: string;
  raw: unknown;
};

export type WebhookRequest = {
  /** The raw request body, exactly as received. Don't parse and re-serialise it: signatures are computed over these bytes. */
  body: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  /** The full request URL. Needed for MTN MoMo, whose callbacks carry the reference in the URL. */
  url?: string;
};

export interface MobileMoneyProvider {
  readonly name: string;
  /** Starts a mobile money collection (a prompt or OTP on the payer's phone). */
  collect(request: CollectRequest): Promise<CollectResult>;
  /** Completes a collection that returned `otp_required`. Pass the same request you passed to `collect()`. */
  submitOtp(request: CollectRequest, otp: string): Promise<CollectResult>;
  /** Asks the provider for the payment's current state. */
  verify(reference: string): Promise<Payment>;
  /**
   * Authenticates a webhook (where the provider supports it), then confirms
   * the payment with `verify()`. Never trust a webhook body on its own.
   * Returns null for events that aren't about a collection.
   */
  handleWebhook(request: WebhookRequest): Promise<Payment | null>;
}

export type ProviderOptions = HttpOptions;
