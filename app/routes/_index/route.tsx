import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

const FEATURES = [
  {
    title: "Sales = Square + Shopify",
    body: "Sync retail POS and online orders into one timeline, this year beside last.",
  },
  {
    title: "SKU = the weld",
    body: "Map each Square item to its Shopify product once; every report reconciles both channels.",
  },
  {
    title: "Report = one click",
    body: "Weekly channels, categories, and top 10 — on screen and exported to .xlsx.",
  },
];

// Non-embedded route: AppProvider injects polaris.js (the Polaris web
// components) without App Bridge, so the public landing page renders with the
// real Shopify admin look. Same pattern as app/routes/auth.login/route.tsx.
export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const [shop, setShop] = useState("");

  return (
    <AppProvider embedded={false}>
      <s-page heading="SKUweld by TE">
        <s-section>
          <s-stack direction="block" gap="base">
            <s-badge tone="info">Internal</s-badge>
            <s-paragraph color="subdued">
              Weld Square and Shopify sales into one report. Sync both channels,
              map SKUs once, and walk into the weekly meeting with numbers that
              reconcile.
            </s-paragraph>
            {showForm && (
              <Form method="post" action="/auth/login">
                <s-stack direction="block" gap="small">
                  <s-text-field
                    name="shop"
                    label="Shop domain"
                    details="example.myshopify.com"
                    placeholder="my-shop.myshopify.com"
                    value={shop}
                    onChange={(event) => setShop(event.currentTarget.value)}
                    autocomplete="on"
                  ></s-text-field>
                  <s-button type="submit" variant="primary">
                    Log in
                  </s-button>
                </s-stack>
              </Form>
            )}
          </s-stack>
        </s-section>

        <s-section heading="What it does">
          <s-stack direction="block" gap="base">
            {FEATURES.map((feature, index) => (
              <s-stack key={feature.title} direction="inline" gap="base">
                <s-text color="subdued">
                  {String(index + 1).padStart(2, "0")}
                </s-text>
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{feature.title}</s-text>
                  <s-text color="subdued">{feature.body}</s-text>
                </s-stack>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
