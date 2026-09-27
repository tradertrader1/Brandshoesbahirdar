MAIN ADMIN / MULTI-STORE CONTROL

The Main Admin is the admin account configured by Render environment variables:
  ADMIN_USER=your-main-admin-username
  ADMIN_PASS=your-main-admin-password

On startup, that username is marked as the single Main Admin. Other admins can still create their own stores through Admin -> Create Admin Account, but only the Main Admin can see the "Manage Admins" tab.

Main Admin capabilities:
- View all admin accounts and their stores.
- Deny access to an admin account. This immediately invalidates that admin's active sessions and prevents future login.
- Allow access again.
- The Main Admin cannot be disabled from the Manage Admins screen.

Important:
- Keep ADMIN_USER and ADMIN_PASS secret in Render Environment Variables.
- Do not put these values in GitHub.
- A disabled admin's store data is not deleted; access is only blocked.
