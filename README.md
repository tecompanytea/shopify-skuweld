# Skuweld

Embedded Shopify admin app that connects a Shopify store with a Square account
for **product parity by SKU**: see which products live on which channel and
which are missing from one.

## What it does (v1)

- **Connect Square** via OAuth — the merchant sees Square's
  "Skuweld wants access to your Square Account" consent page (read-only scopes:
  `ITEMS_READ`, `INVENTORY_READ`, `MERCHANT_PROFILE_READ`).
- **Products** — per-channel tables of Shopify and Square products with
  name, inventory, and channel.
- **SKU Mapping** — live SKU matching across channels: in both / Shopify only
  / Square only, with duplicate-SKU warnings.

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
npm test             # vitest unit tests (parity matching)
npm run typecheck
```

See [SETUP.md](./SETUP.md) for the one-time external setup (Shopify Partner
app, Neon, Vercel, Square Developer Dashboard).
