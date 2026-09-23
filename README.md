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

## Per-size inventory
When adding a product in Admin > Products / Stock, enter the available sizes and click **Set quantities**. Enter the number of pairs for each size. Customers must select a size before adding to cart, and checkout decrements inventory for the exact size sold. Sold-out sizes are disabled automatically.

## Stock confirmation behavior
Customers can place orders normally. Placing an order does NOT reduce product or size stock. The product page continues to show the same available quantity while an order is NEW/pending.

Stock is reduced only when an Admin clicks **Confirm order** in Admin → Orders. The server re-checks each exact product size at confirmation time and then decrements only those confirmed quantities. If there is insufficient stock at confirmation, the order remains unconfirmed and no stock is changed.


## Discount Coupon
Admin → Settings lets you set one active coupon code and its discount percentage. Customers enter the code in the cart and the server validates it before applying the discount. The discount is calculated from the product subtotal; delivery is added after the discount.

## Color inventory
Products can now have available colors with separate quantities, just like sizes. Customers must select a color when a product has colors. Sold-out colors are disabled. The selected color is stored in the order, shown in WhatsApp details, and color inventory is decremented only when the admin confirms the order.


## SMSEthiopia Admin SMS Notifications

This version can send an SMS to the store admin whenever a new customer order is placed. The SMS uses SMSEthiopia's REST API.

Add these environment variables in Render: 
- `SMS_API_KEY` = your private SMSEthiopia API key
- `SMS_ADMIN_PHONE` = admin phone in international format, for example `251945306592`

The API key must stay in Render Environment Variables and must not be put in `index.html` or committed to GitHub. If SMS sending fails, the order is still saved normally and the Admin red-dot notification still works.
