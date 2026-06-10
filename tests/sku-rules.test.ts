import { describe, expect, it } from "vitest";
import { evaluateRule, isSkuClean } from "../app/lib/sku-rules";

const rule = (type: string, value: string | null = null, enabled = true) => ({
  type,
  value,
  enabled,
});

describe("evaluateRule", () => {
  it("REGEX matches and rejects", () => {
    expect(evaluateRule(rule("REGEX", "^TE-\\d{4}$"), "TE-1234")).toBe(true);
    expect(evaluateRule(rule("REGEX", "^TE-\\d{4}$"), "TE-12")).toBe(false);
  });

  it("REGEX with invalid pattern passes instead of poisoning the list", () => {
    expect(evaluateRule(rule("REGEX", "("), "ANYTHING")).toBe(true);
  });

  it("PREFIX checks the start of the SKU", () => {
    expect(evaluateRule(rule("PREFIX", "TE-"), "TE-OOLONG")).toBe(true);
    expect(evaluateRule(rule("PREFIX", "TE-"), "OOLONG-TE")).toBe(false);
  });

  it("MIN_LENGTH and MAX_LENGTH bound the length", () => {
    expect(evaluateRule(rule("MIN_LENGTH", "5"), "ABCDE")).toBe(true);
    expect(evaluateRule(rule("MIN_LENGTH", "5"), "ABCD")).toBe(false);
    expect(evaluateRule(rule("MAX_LENGTH", "5"), "ABCDE")).toBe(true);
    expect(evaluateRule(rule("MAX_LENGTH", "5"), "ABCDEF")).toBe(false);
  });

  it("non-numeric length values pass instead of failing everything", () => {
    expect(evaluateRule(rule("MIN_LENGTH", "abc"), "X")).toBe(true);
  });

  it("NO_SPACES rejects any whitespace", () => {
    expect(evaluateRule(rule("NO_SPACES"), "TE-123")).toBe(true);
    expect(evaluateRule(rule("NO_SPACES"), "TE 123")).toBe(false);
    expect(evaluateRule(rule("NO_SPACES"), "TE\t123")).toBe(false);
  });

  it("DIGITS_ONLY requires a fully numeric SKU", () => {
    expect(evaluateRule(rule("DIGITS_ONLY"), "12345")).toBe(true);
    expect(evaluateRule(rule("DIGITS_ONLY"), "12a45")).toBe(false);
    expect(evaluateRule(rule("DIGITS_ONLY"), "")).toBe(false);
  });

  it("UPPERCASE rejects lowercase letters", () => {
    expect(evaluateRule(rule("UPPERCASE"), "TE-123")).toBe(true);
    expect(evaluateRule(rule("UPPERCASE"), "te-123")).toBe(false);
  });

  it("unknown rule types pass", () => {
    expect(evaluateRule(rule("FUTURE_RULE"), "X")).toBe(true);
  });
});

describe("isSkuClean", () => {
  it("requires every enabled rule to pass", () => {
    const rules = [rule("PREFIX", "TE-"), rule("NO_SPACES")];
    expect(isSkuClean(rules, "TE-123")).toBe(true);
    expect(isSkuClean(rules, "TE 123")).toBe(false);
    expect(isSkuClean(rules, "XX-123")).toBe(false);
  });

  it("ignores disabled rules", () => {
    const rules = [rule("PREFIX", "TE-", false)];
    expect(isSkuClean(rules, "XX-123")).toBe(true);
  });

  it("no rules means clean", () => {
    expect(isSkuClean([], "anything goes")).toBe(true);
  });
});
