# Brand Shoes — Real Store

This version is prepared for GitHub + Render and includes:
- ETB pricing
- Responsive customer storefront
- Product search and category filter
- Size selection
- Cart and checkout
- Stock decrement when orders are placed
- Admin product/stock management
- Admin order management
- WhatsApp order confirmation link
- PostgreSQL support when `DATABASE_URL` is configured
- SQLite fallback for testing
- Optional Cloudinary image storage for permanent product photos

## Render Environment Variables

Set these in Render → Settings → Environment:

ADMIN_USER=your-admin-username
ADMIN_PASS=use-a-strong-password
STORE_NAME=BRAND SHOES BAHIRDAR
CURRENCY=ETB
251945306592=2519XXXXXXXX

For a persistent production database, add a Render PostgreSQL database and set:
DATABASE_URL=<Render PostgreSQL connection string>

For permanent uploaded product images, create a Cloudinary account and set:
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

If Cloudinary is not configured, uploads are saved locally (fine for testing, not recommended for permanent production storage).

## Deployment

Push the files to GitHub. Render should auto-deploy from the connected repository.

Build: npm install
Start: npm start
