import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha512Hex(key: string, data: string): string {
  return createHmac("sha512", key).update(data, "utf8").digest("hex");
}

/** Constant-time string comparison, so response timing doesn't leak how much of a secret matched. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
