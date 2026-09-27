PAYMENT SETUP

Pay Later
- Always available.
- Places the order immediately without payment.
- Customer pays on arrival.

Other methods
- Mastercard, Telebirr, and Bank transfer are configurable in Admin > Settings.
- A method can be enabled and given a hosted payment URL/details.
- This version intentionally does NOT create an order for paid methods until a real payment gateway callback/verification is integrated. A link alone is not treated as proof of payment.

Live integration requirements
- Telebirr: merchant/developer credentials from the official Telebirr developer portal and a server-side callback/notification endpoint.
- Mastercard: merchant/acquirer/payment-gateway credentials and a hosted checkout/session integration with server-side confirmation.
- Bank transfer: bank/account details plus a verification method or payment provider/API if automatic confirmation is required.

Never put raw card numbers, CVV, private keys, or gateway secrets into the Admin UI. Use Render environment variables for secrets.
