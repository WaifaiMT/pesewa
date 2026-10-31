import { describe, expect, it } from "vitest";
import { detectNetwork, fromMajor, normalizeGhanaPhone, PesewaError, toMajorString } from "../src";

describe("normalizeGhanaPhone", () => {
  it.each(["0241234567", "241234567", "233241234567", "+233241234567", "+233 24 123 4567", "00233241234567", "024-123-4567"])(
    "normalises %s",
    (input) => {
      expect(normalizeGhanaPhone(input)).toEqual({ e164: "+233241234567", msisdn: "233241234567", local: "0241234567" });
    },
  );

  it.each(["", "12345", "02412345678", "+2340241234567", "abc"])("rejects %s", (input) => {
    expect(() => normalizeGhanaPhone(input)).toThrow(PesewaError);
  });
});

describe("detectNetwork", () => {
  it.each([
    ["0241234567", "mtn"],
    ["0551234567", "mtn"],
    ["0531234567", "mtn"],
    ["0201234567", "telecel"],
    ["0501234567", "telecel"],
    ["0261234567", "at"],
    ["0571234567", "at"],
    ["0301234567", null],
  ])("%s → %s", (phone, network) => {
    expect(detectNetwork(phone)).toBe(network);
  });
});

describe("money", () => {
  it("formats minor units as decimal strings", () => {
    expect(toMajorString(1050)).toBe("10.50");
    expect(toMajorString(1000)).toBe("10.00");
    expect(toMajorString(5)).toBe("0.05");
  });

  it("parses decimal amounts without floating-point drift", () => {
    expect(fromMajor("10.50")).toBe(1050);
    expect(fromMajor("0.1")).toBe(10);
    expect(fromMajor("19.99")).toBe(1999);
    expect(fromMajor(0.29)).toBe(29);
    expect(fromMajor("100")).toBe(10000);
  });

  it("rejects non-integer or non-positive amounts", () => {
    for (const bad of [0, -100, 10.5, Number.NaN]) {
      expect(() => toMajorString(bad)).toThrow(/positive integer/);
    }
  });
});

describe("network failures", () => {
  const failing = (error: Error) => (async () => {
    throw error;
  }) as unknown as typeof fetch;

  it("reports timeouts and connection errors as network errors", async () => {
    const { Paystack } = await import("../src");
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await expect(new Paystack({ secretKey: "sk", fetch: failing(timeout) }).verify("r")).rejects.toMatchObject({
      code: "network",
      message: "paystack request timed out",
    });
    await expect(new Paystack({ secretKey: "sk", fetch: failing(new TypeError("fetch failed")) }).verify("r")).rejects.toMatchObject({
      code: "network",
      message: "Couldn't reach paystack",
    });
  });

  it("aborts requests that exceed timeoutMs", async () => {
    const { Paystack } = await import("../src");
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    await expect(new Paystack({ secretKey: "sk", fetch: hanging, timeoutMs: 50 }).verify("r")).rejects.toMatchObject({ code: "network" });
  });
});
