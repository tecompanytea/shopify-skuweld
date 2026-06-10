export const SKU_RULE_TYPES = [
  "REGEX",
  "PREFIX",
  "MIN_LENGTH",
  "MAX_LENGTH",
  "NO_SPACES",
  "DIGITS_ONLY",
  "UPPERCASE",
] as const;

export type SkuRuleType = (typeof SKU_RULE_TYPES)[number];

export interface SkuRuleInput {
  type: string;
  value: string | null;
  enabled: boolean;
}

export const RULE_TYPE_LABELS: Record<SkuRuleType, string> = {
  REGEX: "Matches regex",
  PREFIX: "Starts with",
  MIN_LENGTH: "Minimum length",
  MAX_LENGTH: "Maximum length",
  NO_SPACES: "No spaces",
  DIGITS_ONLY: "Digits only",
  UPPERCASE: "All uppercase",
};

// Rules whose `value` field is meaningful (others are boolean checks).
export const RULE_TYPES_WITH_VALUE: SkuRuleType[] = [
  "REGEX",
  "PREFIX",
  "MIN_LENGTH",
  "MAX_LENGTH",
];

// Rules are evaluated against the raw SKU as it exists in the channel —
// the normalized key already strips case/whitespace, which would mask
// UPPERCASE and NO_SPACES violations.
export function evaluateRule(rule: SkuRuleInput, rawSku: string): boolean {
  switch (rule.type) {
    case "REGEX": {
      if (!rule.value) return true;
      try {
        return new RegExp(rule.value).test(rawSku);
      } catch {
        // An invalid pattern should not poison the whole clean list.
        return true;
      }
    }
    case "PREFIX":
      return rule.value ? rawSku.startsWith(rule.value) : true;
    case "MIN_LENGTH": {
      const min = Number(rule.value);
      return Number.isFinite(min) ? rawSku.length >= min : true;
    }
    case "MAX_LENGTH": {
      const max = Number(rule.value);
      return Number.isFinite(max) ? rawSku.length <= max : true;
    }
    case "NO_SPACES":
      return !/\s/.test(rawSku);
    case "DIGITS_ONLY":
      return /^\d+$/.test(rawSku);
    case "UPPERCASE":
      return rawSku === rawSku.toUpperCase();
    default:
      return true;
  }
}

// A SKU is clean iff every enabled rule passes. No rules -> clean.
export function isSkuClean(rules: SkuRuleInput[], rawSku: string): boolean {
  return rules
    .filter((rule) => rule.enabled)
    .every((rule) => evaluateRule(rule, rawSku));
}
