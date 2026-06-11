# Skuweld one-time setup

Work through these in order. Steps 1–4 need logins only you have; every command
is run from the repo root.

## 1. Shopify Partner app

```bash
npm run config:link        # shopify app config link — log in, "Create new app", name: Skuweld
```

This fills `client_id` in `shopify.app.toml`. Then grab the API secret:

```bash
npm run env -- show        # copy SHOPIFY_API_KEY / SHOPIFY_API_SECRET
```

## 2. Neon (Postgres)

1. https://neon.tech → new project `skuweld`.
2. Copy the **pooled** connection string → `DATABASE_URL`.
3. Copy the **direct** (unpooled) connection string → `DATABASE_URL_UNPOOLED`.

## 3. Vercel

1. Push this repo to GitHub, import it at https://vercel.com/new.
2. Project name `skuweld` (gives `https://skuweld-app.vercel.app`; if taken, use
   whatever Vercel assigns and substitute that domain everywhere below).
3. The build command comes from `vercel.json` (`npm run setup:deploy && npm run build`
   — runs Prisma migrations on deploy).
4. Set environment variables (Production):

   | Variable | Value |
   |---|---|
   | `SHOPIFY_API_KEY` | from step 1 |
   | `SHOPIFY_API_SECRET` | from step 1 |
   | `SHOPIFY_APP_URL` | `https://skuweld-app.vercel.app` |
   | `SHOPIFY_APP_HANDLE` | `skuweld-1` (the app handle from the Partner dashboard URL) |
   | `SCOPES` | `read_inventory,read_locations,read_products` |
   | `DATABASE_URL` | Neon pooled |
   | `DATABASE_URL_UNPOOLED` | Neon direct |
   | `SQUARE_APPLICATION_ID` | from step 4 |
   | `SQUARE_APPLICATION_SECRET` | from step 4 |
   | `SQUARE_REDIRECT_URL` | `https://skuweld-app.vercel.app/square/auth/callback` |
   | `SQUARE_STATE_SECRET` | `openssl rand -hex 32` |
   | `SQUARE_TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` (must be 64 hex chars) |

## 4. Square Developer Dashboard

1. https://developer.squareup.com/apps → **+ New application** → name `Skuweld`.
2. Switch the dashboard toggle to **Production** (not Sandbox).
3. Credentials page → copy **Application ID** and **Application Secret**
   (these are the `SQUARE_*` values for step 3).
4. OAuth page → set **Production Redirect URL** to
   `https://skuweld-app.vercel.app/square/auth/callback`.

## 5. Deploy + install

```bash
git push                   # Vercel builds + migrates the DB
npm run deploy             # shopify app deploy — pushes toml (scopes, webhooks, redirect URLs)
```

Update `application_url` / `redirect_urls` in `shopify.app.toml` first if your
Vercel domain isn't `skuweld-app.vercel.app`.

Then install the app on the store: Partner Dashboard → Apps → Skuweld →
**Select store** → install on `tecompanytea`. Open it in the Shopify admin,
go to **Settings → Connect Square**, and approve on Square's consent page.

## 6. Verify

- Dashboard shows "Square: <your business name>".
- Products page lists both catalogs with inventory.
- Parity page buckets match a spot check.
- SKUs → "Sync SKUs" populates the master list; re-running it creates no dupes.
- Settings → Disconnect removes the app under Square Dashboard → authorized apps.
