# Shoe Store PRO

A real multi-customer shoe shop starter: shared SQLite inventory, product photo uploads, customer checkout, automatic stock decrement, order database and password-protected admin API.

## Run locally
1. Install Node.js 18+.
2. In this folder run `npm install`.
3. Set an admin password:
   - Windows PowerShell: `$env:ADMIN_PASS="your-strong-password"`
   - macOS/Linux: `export ADMIN_PASS="your-strong-password"`
4. Run `npm start`.
5. Open `http://localhost:3000`.

Default username is `admin`. Change `ADMIN_USER` too for production.

## Production
Use HTTPS, a strong admin password, persistent storage, regular database backups, and a managed database/image service before public launch. For multiple server instances, replace SQLite with PostgreSQL.

Payment gateways and WhatsApp notifications should be connected using the provider credentials appropriate to your country. Never place secret API keys in browser JavaScript.

## Demo stock
On a fresh database, the app automatically seeds 5 sample Nike Air Force 1 listings in white/black variants with sample USD prices.
