import { PesewaError } from "./errors";

export type Network = "mtn" | "telecel" | "at";

/** A Ghana mobile number in the three formats providers ask for. */
export type GhanaPhone = {
  /** +233241234567 */
  e164: string;
  /** 233241234567 (MSISDN, no plus) */
  msisdn: string;
  /** 0241234567 */
  local: string;
};

// Ghana mobile prefixes (the digits after the leading 0) by network
const PREFIXES: Record<Network, string[]> = {
  mtn: ["24", "25", "53", "54", "55", "59"],
  telecel: ["20", "50"],
  at: ["26", "27", "56", "57"],
};

/**
 * Accepts 0241234567, 241234567, 233241234567, +233 24 123 4567, or
 * 00233241234567 and returns all three canonical formats.
 */
export function normalizeGhanaPhone(input: string): GhanaPhone {
  let digits = input.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("233")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);

  if (!/^\d{9}$/.test(digits)) {
    throw new PesewaError("invalid_request", `Not a valid Ghana mobile number: ${JSON.stringify(input)}`);
  }
  return { e164: `+233${digits}`, msisdn: `233${digits}`, local: `0${digits}` };
}

/**
 * Detects the network from the number's prefix. Returns null for unknown
 * prefixes. Ported numbers keep their old prefix, so let users override it.
 */
export function detectNetwork(phone: string): Network | null {
  const prefix = normalizeGhanaPhone(phone).local.slice(1, 3);
  for (const [network, prefixes] of Object.entries(PREFIXES) as [Network, string[]][]) {
    if (prefixes.includes(prefix)) return network;
  }
  return null;
}

/** The given network, or the detected one; throws if neither is known. */
export function resolveNetwork(phone: string, network?: Network): Network {
  const resolved = network ?? detectNetwork(phone);
  if (!resolved) {
    throw new PesewaError("invalid_request", `Can't tell the network for ${phone}; pass network: "mtn" | "telecel" | "at".`);
  }
  return resolved;
}
