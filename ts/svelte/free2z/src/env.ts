import { defineEnvVars } from "@sveltejs/kit/env";

// Preserve optional runtime configuration; application helpers supply defaults.
const optionalString = (value: string | undefined) => value;

export const variables = defineEnvVars({
  APP_RELEASE_ID: { public: false, schema: optionalString },
  DEPLOYMENT_SHA: { public: false, schema: optionalString },
  OG_MAX_CONCURRENT_RENDERS: { public: false, schema: optionalString },
  OG_MAX_QUEUE: { public: false, schema: optionalString },
  OG_RENDER_QUEUE_TIMEOUT_MS: { public: false, schema: optionalString },
  PRIVATE_API_BASE_URL: { public: false, schema: optionalString },
  PRIVATE_BACKEND_TRUSTED_ORIGINS: { public: false, schema: optionalString },
  PUBLIC_API_BASE_URL: { public: true, schema: optionalString },
  PUBLIC_BUILD_SHA: { public: true, schema: optionalString },
  PUBLIC_CANONICAL_BASE_URL: { public: true, schema: optionalString },
  PUBLIC_F2Z_ZCASH_ADDRESS: { public: true, schema: optionalString },
  PUBLIC_IFRAMELY_API_KEY: { public: true, schema: optionalString },
  PUBLIC_RECAPTCHA_SITE_KEY: { public: true, schema: optionalString },
  PUBLIC_STRIPE_CHECKOUT_ENABLED: { public: true, schema: optionalString },
});
