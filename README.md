# Skuweld

Embedded Shopify admin app that connects a Shopify store with a Square account
for **product parity by SKU**: see which products live on which channel, keep a
master list of SKUs, and enforce SKU naming rules.

## What it does (v1)

- **Connect Square** via OAuth — the merchant sees Square's
  "Skuweld wants access to your Square Account" consent page (read-only scopes:
  `ITEMS_READ`, `INVENTORY_READ`, `MERCHANT_PROFILE_READ`).
- **Products** — side-by-side tables of Shopify and Square products with
  name, inventory, and channel.
- **Parity** — SKU matching across channels: in both / Shopify only / Square
  only, with duplicate-SKU warnings.
- **SKUs** — persisted master list (union of every SKU seen on either channel),
  a clean list, and configurable naming rules (regex, prefix, length, no
  spaces, digits only, uppercase).

Planned next: Square locations, per-location analytics, Create Product pushed
to both channels.

## Stack

React Router v7 + TypeScript · `@shopify/shopify-app-react-router` (embedded,
SingleMerchant) · Prisma + Postgres (Neon) · Polaris web components · Vercel.
Square is called with a plain `fetch` wrapper (`app/.server/square/`); tokens
are AES-256-GCM encrypted at rest and refreshed on use.

## Development

```bash
npm install
npm run dev          # shopify app dev (needs `shopify app config link` once)
npm test             # vitest unit tests (sku rules, parity)
npm run typecheck
```

See [SETUP.md](./SETUP.md) for the one-time external setup (Shopify Partner
app, Neon, Vercel, Square Developer Dashboard).
