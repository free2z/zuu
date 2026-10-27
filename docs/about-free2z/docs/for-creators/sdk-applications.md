# Build with the Free2Z SDK preview

Create a tutor, a writing partner, or a useful tool for your community. The **open-source SDK preview** connects your application to Free2Z sign-in, user credit budgets, and supported AI services.

You build and host the application. The gateway handles supported AI requests and credit charges, so the browser gateway flow does not require your own AI-provider keys. Users authorize what your app can spend and can manage that access in Connected apps.

## Explore the source preview

Use the SDK from source; npm packages are not available. Start with the [source preview guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/SOURCE-PREVIEW.md) and [integration guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/INTEGRATION.md) for setup, available endpoints, and the browser or native flow that fits your application.

1. Sign in and open [Developer apps](https://free2z.com/developers/apps).
2. Register your application and configure its redirect addresses.
3. Follow the source preview and integration guides. Keep credentials out of public pages and browser bundles.
4. Explain what your application does, its spending limits, and any displayed markup.
5. Test sign-in, authorization, service delivery, and spending limits with your own accounts before inviting users.

Request only the access your application needs. Users can review or remove authorization in **Connected apps**.

## How your users get 2Z

Your app doesn't sell 2Z. Users buy 2Z on Free2Z (Zcash preferred, or card) and spend them in any app they've authorized.

- **Web or directly downloaded desktop apps** may link to `https://free2z.cash/buy-2z?client_id=<your client id>`.
- **Store-distributed builds** (Google Play, and iOS outside the US storefront) must not link to buying at all. Offer only "Manage Free2Z account".

See the SDK's [STORE-COMPLIANCE guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/STORE-COMPLIANCE.md) for the exact rules.

## Apply to earn from delivered services

Apply for creator participation and get approved, then accept the compensation agreement and SDK service terms. Check Credits & Earnings to confirm that your account is eligible for compensated services before offering them.

Qualifying delivered SDK services can earn USD owed by 2Z Inc., tracked separately from users' credits and paid in shielded Zcash. Registration, authorization, and unused budgets do not themselves earn money.

[Set up creator earnings](../revenue-sharing/index.md) and follow recorded SDK earnings and payment requests in Credits & Earnings.
