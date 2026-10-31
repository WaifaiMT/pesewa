import { PesewaError } from "./errors";

/** Amounts are always integers in minor units (pesewas for GHS), so there's no floating-point rounding. */
export function assertMinorUnits(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new PesewaError("invalid_request", `amount must be a positive integer in minor units (e.g. 1050 for GHS 10.50); got ${amount}`);
  }
}

/** 1050 → "10.50", 1000 → "10.00". For providers that take decimal strings in major units. */
export function toMajorString(minor: number): string {
  assertMinorUnits(minor);
  const whole = Math.trunc(minor / 100);
  const fraction = (minor % 100).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

/** "10.50" or 10.5 → 1050. Parses decimal strings without floating-point drift. */
export function fromMajor(value: string | number): number {
  const text = typeof value === "number" ? value.toFixed(2) : value.trim();
  const match = /^(\d+)(?:\.(\d{1,2})\d*)?$/.exec(text);
  if (!match) throw new PesewaError("provider_error", `Unexpected amount from provider: ${JSON.stringify(value)}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
}
