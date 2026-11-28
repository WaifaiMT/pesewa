# Changelog

## 0.2.0

- **Payouts** to mobile money wallets: a `PayoutProvider` interface (`payout`, `verifyPayout`, `handlePayoutWebhook`) and `isPayoutProvider()`.
  - Paystack: Transfers API (transfer recipients, cached per wallet), `transfer.*` webhooks, `transferBankCodes` option. A transfer waiting for an OTP throws `unsupported`.
  - MTN MoMo: Disbursement (`disbursement` option with its own keys and token). Payout references must be a UUID v4, so a retry can't pay twice. Payout callbacks are marked in the callback URL and ignored by `handleWebhook()`.
- MTN MoMo collections: a UUID v4 reference is used as the X-Reference-Id, so a callback that arrives before `collect()` returns still matches.
- `prepare` script, so the package builds when installed from git.

## 0.1.0

- Paystack, Moolre, and MTN MoMo collections behind one `MobileMoneyProvider` interface, verified webhooks, Ghana phone helpers.
