export type PesewaErrorCode =
  | "invalid_request" // bad input, caught before any network call
  | "authentication" // the provider rejected the credentials
  | "duplicate_reference" // the reference was already used
  | "not_found" // the provider doesn't know this reference
  | "invalid_webhook" // signature or secret check failed, or the payload is malformed
  | "unsupported" // the provider doesn't offer this operation
  | "provider_error" // the provider returned an error
  | "network"; // timeout or connection failure

export class PesewaError extends Error {
  readonly name = "PesewaError";

  constructor(
    readonly code: PesewaErrorCode,
    message: string,
    readonly details: { provider?: string; httpStatus?: number; providerCode?: string; raw?: unknown } = {},
  ) {
    super(message);
  }
}
