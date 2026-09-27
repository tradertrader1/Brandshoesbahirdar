MULTI-ADMIN / MULTI-STORE

New functionality:
- Anyone can open Admin -> Create Admin Account.
- Each admin gets a separate store with a unique store link: /?store=<store-slug>.
- Each admin has a private inventory, orders, payment settings, WhatsApp number, delivery fee, coupon and store name.
- Admin authentication uses secure session tokens and hashed passwords.
- Existing environment ADMIN_USER / ADMIN_PASS is migrated into the first store/admin account.
- Customers can browse a specific store using its store link and their orders are attached to that store.
- Order notifications are scoped to the correct store/admin.
- The first admin's existing products/orders are assigned to the first store during migration.

IMPORTANT:
- After deploying, create a new admin from the Admin menu and copy the Store Link shown in Admin -> Settings.
- Share each store's unique link with its customers.
- DATABASE_URL should remain configured on Render so store data and images persist.
