# Build an SDK application

Build a tutor, a writing partner, or a tool for your community. Give people a useful way to use Free2Z services from your app. Users authorize what your app can spend, and you build within their spending limits.

The SDK is available as an **open-source preview**; package releases are coming soon. Start with the public [source-preview guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/SOURCE-PREVIEW.md) and [integration guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/INTEGRATION.md).

## From idea to app

Prototype with your favorite coding tools or AI assistant. Free2Z handles user authorization, spending budgets, metered AI access, and usage-credit charges through the SDK, so you can concentrate on the experience you’re building.

Register your application, connect its sign-in flow, and integrate the supported service calls. You host your application and protect its credentials; AI usage is paid for with authorized 2Z credits.

## Connect your app

1. Explore the source preview and register your app in [Developer apps](https://free2z.com/developers/apps), with its redirect addresses.
2. Follow the source integration guide for sign-in and authorization. Browser sign-in uses PKCE; supported AI calls go through Free2Z’s gateway, so your users don’t need to bring their own AI provider key. Keep private credentials out of public pages and client bundles.
3. Explain what your application does, what services it uses, and the spending and markup users agree to.
4. Test with your own accounts and spending limits before inviting users.

Users can review and remove authorization in Connected apps. A spending authorization lets your app use platform credits within its limits.

## How your users get 2Z

Your app doesn't sell 2Z. Users buy 2Z on Free2Z (Zcash preferred, or card) and spend them in any app they've authorized.

- **Web or directly downloaded desktop apps** may link to `https://free2z.cash/buy-2z?client_id=<your client id>`.
- **Store-distributed builds** (Google Play, and iOS outside the US storefront) must not link to buying at all. Offer only "Manage Free2Z account".

See the SDK's [STORE-COMPLIANCE guide](https://github.com/free2z/zuu/blob/main/docs/free2z/sdk/STORE-COMPLIANCE.md) for the exact rules.

## Earn for a qualifying contribution

A qualifying app service can earn USD owed by 2Z Inc. when your approved, licensed contribution is delivered under the accepted creator agreement and SDK service terms. Complete payee verification, accept those terms, and obtain approval for the contribution and markup before offering compensated service.

Compensation depends on the actual delivered service and collected developer allocation. App registration, unused budgets, credit purchases, and your own test calls do not create earnings. Users’ credits and your USD earnings have separate balances in Credits & Earnings.

[Understand creator earnings](/revenue-sharing/) and [review the compensation terms](/legal/creator-compensation).
