import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { recomputeClean } from "../.server/skus.server";
import {
  RULE_TYPE_LABELS,
  RULE_TYPES_WITH_VALUE,
  SKU_RULE_TYPES,
  type SkuRuleType,
} from "../lib/sku-rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rules = await prisma.skuRule.findMany({
    where: { shop: session.shop },
    orderBy: { position: "asc" },
  });
  return {
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      type: rule.type,
      value: rule.value,
      enabled: rule.enabled,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const type = String(form.get("type") ?? "");
    if (!SKU_RULE_TYPES.includes(type as SkuRuleType)) {
      return { error: "Unknown rule type" };
    }
    const needsValue = RULE_TYPES_WITH_VALUE.includes(type as SkuRuleType);
    const value = String(form.get("value") ?? "").trim();
    if (needsValue && !value) {
      return { error: `${RULE_TYPE_LABELS[type as SkuRuleType]} needs a value` };
    }
    if (type === "REGEX") {
      try {
        new RegExp(value);
      } catch {
        return { error: "Invalid regular expression" };
      }
    }
    const name =
      String(form.get("name") ?? "").trim() ||
      `${RULE_TYPE_LABELS[type as SkuRuleType]}${needsValue ? `: ${value}` : ""}`;
    const last = await prisma.skuRule.findFirst({
      where: { shop: session.shop },
      orderBy: { position: "desc" },
    });
    await prisma.skuRule.create({
      data: {
        shop: session.shop,
        name,
        type,
        value: needsValue ? value : null,
        position: (last?.position ?? 0) + 1,
      },
    });
  }

  if (intent === "toggle") {
    const id = String(form.get("id") ?? "");
    const rule = await prisma.skuRule.findFirst({
      where: { id, shop: session.shop },
    });
    if (rule) {
      await prisma.skuRule.update({
        where: { id: rule.id },
        data: { enabled: !rule.enabled },
      });
    }
  }

  if (intent === "delete") {
    const id = String(form.get("id") ?? "");
    await prisma.skuRule.deleteMany({ where: { id, shop: session.shop } });
  }

  const changed = await recomputeClean(session.shop);
  return { ok: true, changed };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function SkuRules() {
  const { rules } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="SKU rules">
      <s-section heading="Active rules">
        {actionData && "error" in actionData && actionData.error && (
          <s-banner tone="critical">{actionData.error}</s-banner>
        )}
        {actionData && "changed" in actionData && (
          <s-banner tone="success">
            Rules saved. {actionData.changed} SKU
            {actionData.changed === 1 ? "" : "s"} reclassified.
          </s-banner>
        )}

        {rules.length === 0 ? (
          <s-paragraph>
            No rules yet. With no rules, every SKU counts as clean. Add rules
            below to define what a well-formed SKU looks like.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {rules.map((rule) => (
              <s-box
                key={rule.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-badge tone={rule.enabled ? "success" : undefined}>
                    {rule.enabled ? "On" : "Off"}
                  </s-badge>
                  <s-text type="strong">{rule.name}</s-text>
                  <s-text color="subdued">
                    {RULE_TYPE_LABELS[rule.type as SkuRuleType] ?? rule.type}
                    {rule.value ? `: ${rule.value}` : ""}
                  </s-text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="toggle" />
                    <input type="hidden" name="id" value={rule.id} />
                    <s-button type="submit" variant="secondary">
                      {rule.enabled ? "Disable" : "Enable"}
                    </s-button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={rule.id} />
                    <s-button type="submit" variant="secondary" tone="critical">
                      Delete
                    </s-button>
                  </Form>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Add rule">
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="name"
              label="Name (optional)"
              placeholder="e.g. Tea SKUs start with TE-"
            ></s-text-field>
            <s-select name="type" label="Rule type">
              {SKU_RULE_TYPES.map((type) => (
                <s-option key={type} value={type}>
                  {RULE_TYPE_LABELS[type]}
                </s-option>
              ))}
            </s-select>
            <s-text-field
              name="value"
              label="Value"
              details="Pattern for regex, text for prefix, number for length rules. Leave empty for boolean rules."
            ></s-text-field>
            <s-box>
              <s-button type="submit" variant="primary">
                Add rule
              </s-button>
            </s-box>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
