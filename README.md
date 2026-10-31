# pesewa

[![CI](https://github.com/WaifaiMT/pesewa/actions/workflows/ci.yml/badge.svg)](https://github.com/WaifaiMT/pesewa/actions/workflows/ci.yml)

A typed TypeScript SDK for taking payments in Ghana. **Paystack, Moolre, and MTN MoMo** behind one interface, with webhooks that are authenticated and then confirmed with the provider before you ever see a "success".

- **One interface, three providers:** `collect()`, `submitOtp()`, `verify()`, `handleWebhook()`
- **MTN, Telecel, and AT** mobile money, plus cards through Paystack's hosted checkout
- **Safe money handling:** amounts are integers in pesewas, never floats
- **Verified webhooks:** signatures and secrets checked in constant time, then every payment re-confirmed with the provider's API
- **Ghana phone numbers:** any common format normalised; network detected from the prefix
- **Zero runtime dependencies.** Node.js 18.17+ (uses the built-in `fetch` and `crypto`). ESM and CommonJS, fully typed.

```bash
npm install pesewa
```

## Quick start

```ts
import { Paystack } from "pesewa";

const paystack = new Paystack({ secretKey: process.env.PAYSTACK_SECRET_KEY! });

const request = {
  amount: 1050, // GHS 10.50, in pesewas
  phone: "024 123 4567", // any Ghana format; network detected (MTN)
  reference: "order-1001", // your unique id; never reuse one
  email: "ama@example.com",
};
const result = await paystack.collect(request);

if (result.status === "otp_required") {
  // Ask the customer for the code they received, then:
  await paystack.submitOtp(request, otpFromCustomer);
}
// status "pending" → the customer approves the prompt on their phone.
// Wait for the webhook (below) or poll paystack.verify("order-1001").
```

Every provider implements the same `MobileMoneyProvider` interface, so you can swap one for another or route by network:

```ts
import { Moolre, MtnMomo, Paystack, detectNetwork, type MobileMoneyProvider } from "pesewa";

const moolre = new Moolre({ apiUser, publicKey, accountNumber, callbackSecret });
const mtn = new MtnMomo({ subscriptionKey, apiUser, apiKey, environment: "sandbox" });

const provider: MobileMoneyProvider = detectNetwork(phone) === "mtn" ? mtn : moolre;
await provider.collect({ amount: 2000, phone, reference });
```

## Webhooks

`handleWebhook()` never trusts the request body on its own. It authenticates the request where the provider supports it, then asks the provider's API for the real status, and returns that:

| Provider | Authentication | Then |
|---|---|---|
| Paystack | `x-paystack-signature`: HMAC-SHA512 of the raw body with your secret key, compared in constant time | `verify(reference)` |
| Moolre | `data.secret` must equal your `callbackSecret`, compared in constant time | `verify(externalref)` |
| MTN MoMo | MTN doesn't sign callbacks; the reference comes from the callback URL that `collect()` registered | `verify(reference)` |

Pass the **raw** body. Signatures are computed over the exact bytes, so parsing and re-serialising JSON breaks them.

```ts
// Next.js route handler
export async function POST(req: Request) {
  try {
    const payment = await paystack.handleWebhook({ body: await req.text(), headers: req.headers, url: req.url });
    if (payment?.status === "success") await markOrderPaid(payment.reference, payment.amount);
    return new Response("ok");
  } catch (error) {
    if (error instanceof PesewaError && error.code === "invalid_webhook") return new Response("invalid", { status: 400 });
    throw error;
  }
}
```

```ts
// Express: keep the raw body for this route
app.post("/webhooks/paystack", express.text({ type: "*/*" }), async (req, res) => {
  const payment = await paystack.handleWebhook({ body: req.body, headers: req.headers });
  // ...
  res.sendStatus(200);
});
```

Providers can deliver the same webhook more than once. Make your handling idempotent (for example, only mark an order paid if it isn't already).

## API

### `collect(request) → CollectResult`

| Field | Type | Notes |
|---|---|---|
| `amount` | `number` | **Required.** Integer in minor units: `1050` = GHS 10.50 |
| `phone` | `string` | **Required.** `0241234567`, `+233 24 123 4567`, `233241234567`, ... |
| `reference` | `string` | **Required.** Your unique reference |
| `currency` | `string` | Default `"GHS"` |
| `network` | `"mtn" \| "telecel" \| "at"` | Detected from the prefix if omitted. Pass it for ported numbers. |
| `email` | `string` | Paystack requires one (or set `fallbackEmailDomain`) |
| `description`, `metadata` | | Passed through where supported |

Returns `{ status, reference, message?, raw }`, where `status` is `pending`, `otp_required`, `success`, or `failed`. Pass `result.reference` to `verify()`. For MTN MoMo it's MTN's request id (a UUID), not your reference.

### `verify(reference) → Payment`

`{ status: "success" | "pending" | "failed", amount?, currency?, providerTransactionId?, paidAt?, failureReason?, raw }`, with amounts in minor units.

### Paystack extras

```ts
await paystack.initializeCheckout({ amount: 5000, email, reference, callbackUrl }); // hosted page: cards + mobile money
await paystack.refund({ reference: "order-1001", amount: 500 }); // full or partial
await paystack.listMobileMoneyProviders("ghana"); // live provider codes
```

### Utilities

```ts
normalizeGhanaPhone("+233 24 123 4567"); // { e164: "+233241234567", msisdn: "233241234567", local: "0241234567" }
detectNetwork("0201234567"); // "telecel"
toMajorString(1050); // "10.50"
fromMajor("10.50"); // 1050
```

### Errors

Everything throws `PesewaError` with a `code` you can switch on: `invalid_request`, `authentication`, `duplicate_reference`, `not_found`, `invalid_webhook`, `unsupported`, `provider_error`, `network`. `error.details` carries the provider, HTTP status, provider code, and raw response.

## Provider notes

**Paystack.** Mobile money codes default to `mtn`, `vod` (Telecel), and `atl` (AT); override them with `providerCodes` if `listMobileMoneyProviders()` shows different ones for your account. Charges usually return `pay_offline` (approve on phone) or `send_otp`.

**Moolre.** Collections and status checks send `X-API-USER` and `X-API-PUBKEY`, as in Moolre's API reference. Collections can need a one-time phone verification: the first call returns `otp_required`, and `submitOtp()` resubmits with the code. Set `sandbox: true` (and optionally `skipOtpInSandbox`) for testing.

**MTN MoMo.** Use `MtnMomo.createSandboxUser({ subscriptionKey, callbackHost })` to get sandbox credentials. The sandbox only accepts `EUR`. In production, set `environment` (e.g. `"mtnghana"`) and `baseUrl` from your MTN onboarding. `callbackUrl` must be on the callback host registered for your API user. MTN collects only from MTN numbers.

## Testing

```bash
npm test
```

The suite (54 tests) checks the exact requests sent to each provider (URLs, headers, bodies, amounts), how responses map to statuses, the OTP flows, token caching, error mapping, timeouts, and webhook authentication, including forged, tampered, and missing signatures. The request formats follow each provider's official API reference and production code these integrations were extracted from. They are tested against recorded API shapes, not live sandboxes; please open an issue if a provider changes something.

## Roadmap

- Payouts (Paystack transfers, Moolre transfers, MTN Disbursements)
- Hubtel provider
- Retries with backoff for status polling

## License

MIT
