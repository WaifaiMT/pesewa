import type { HttpOptions } from "./http";
import type { Network } from "./phone";

export type CollectRequest = {
  /** Integer amount in minor units: 1050 = GHS 10.50. */
  amount: number;
  /** ISO currency. Default "GHS". (MTN's sandbox only accepts "EUR".) */
  currency?: string;
  /** The payer's mobile number, in any common Ghana format. */
  phone: string;
  /**
   * Your unique reference for this payment. Never reuse one. For MTN MoMo, use a
   * UUID v4 (e.g. `crypto.randomUUID()`) and it becomes MTN's X-Reference-Id, so
   * `verify()` and callbacks use the same id you stored.
   */
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
  /** The id to pass to `verify()`. Your reference for Paystack and Moolre; for MTN MoMo, MTN's X-Reference-Id (your reference if it was a UUID v4, otherwise a new UUID). */
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

// ---- Payouts --------------------------------------------------------------

export type PayoutRequest = {
  /** Integer amount in minor units: 5000 = GHS 50.00. */
  amount: number;
  /** ISO currency. Default "GHS". (MTN's sandbox only accepts "EUR".) */
  currency?: string;
  /** The recipient's mobile number, in any common Ghana format. */
  phone: string;
  /** The recipient's network. Detected from the number if omitted. */
  network?: Network;
  /**
   * Your unique reference for this payout. Never reuse one: it's what stops a
   * retry from paying twice. Use a UUID v4 (`crypto.randomUUID()`): it meets
   * Paystack's rules (16–50 characters: lowercase letters, digits, - and _),
   * and MTN uses it as its own request id.
   */
  reference: string;
  /** The recipient's name, as on their wallet where you know it. */
  name: string;
  /** Short narration shown to the recipient where the provider supports it. */
  reason?: string;
};

/**
 * - `pending`: accepted; wait for the webhook or poll `verifyPayout()`
 * - `success`: the money reached the recipient's wallet
 * - `failed`: it didn't go out
 * - `reversed`: it went out, then came back (Paystack reports this for wallets that rejected it)
 */
export type PayoutStatus = "pending" | "success" | "failed" | "reversed";

export type PayoutResult = {
  provider: string;
  status: PayoutStatus;
  /** The id to pass to `verifyPayout()`: your reference. */
  reference: string;
  message?: string;
  raw: unknown;
};

/** A payout's state, as confirmed with the provider's API. */
export type Payout = {
  provider: string;
  reference: string;
  status: PayoutStatus;
  /** Minor units, when the provider reports it. */
  amount?: number;
  currency?: string;
  providerTransactionId?: string;
  failureReason?: string;
  raw: unknown;
};

export interface PayoutProvider {
  readonly name: string;
  /** Sends money to a mobile money wallet. Safe to retry with the same reference: providers refuse a duplicate. */
  payout(request: PayoutRequest): Promise<PayoutResult>;
  /** Asks the provider for the payout's current state. */
  verifyPayout(reference: string): Promise<Payout>;
  /**
   * Authenticates a webhook (where the provider supports it), then confirms
   * the payout with `verifyPayout()`. Returns null for events that aren't
   * about a payout, so you can pass every webhook to both handlers.
   */
  handlePayoutWebhook(request: WebhookRequest): Promise<Payout | null>;
}

/** True for providers that can send payouts. */
export function isPayoutProvider(provider: object): provider is PayoutProvider {
  const p = provider as Partial<PayoutProvider>;
  return typeof p.payout === "function" && typeof p.verifyPayout === "function" && typeof p.handlePayoutWebhook === "function";
}

export type ProviderOptions = HttpOptions;
