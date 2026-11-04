import { defineConfig } from "orval";
import { existsSync } from "node:fs";

const schemaTarget = "../../../py/free2z/dj/free2z/openapi/f2z.yaml";

if (!existsSync(schemaTarget)) {
  throw new Error("Missing canonical Free2Z OpenAPI schema");
}

export default defineConfig({
  f2z: {
    // Stripe's generated query helpers include trailing whitespace in Orval's
    // raw template. Normalize this security-sensitive checkout surface with
    // the repository-pinned Prettier while leaving the legacy generated tree
    // byte-stable. The API-client gate runs this hook on every regeneration.
    hooks: {
      afterAllFilesWrite: {
        command:
          "prettier --write --ignore-path .prettierignore-orval src/lib/api/stripe/stripe.ts src/lib/api/economy/economy.ts",
        injectGeneratedDirsAndFiles: false,
      },
    },
    input: {
      target: schemaTarget,
    },
    output: {
      target: "src/lib/api",
      client: "svelte-query",
      // Preserve descriptor-shaped calls, parsed-data return types, and the
      // separate AbortSignal argument expected by our fetch-backed mutator.
      // Orval 8 defaults to a different fetch-generator contract.
      httpClient: "axios",
      mode: "tags-split",
      override: {
        // Private self reads use direct fetches. A URL-only shared query key
        // would retain another account's earnings or legal identity in an SPA.
        // Consumers that add caching must supply an actor-scoped lifecycle.
        operations: {
          economy_agreement_accept: { query: { useMutation: false } },
          economy_payment_request: { query: { useMutation: false } },
          economy_usage_purchase: { query: { useMutation: false } },
          economy_earnings: { query: { useQuery: false } },
          economy_payments_list: { query: { useQuery: false } },
          economy_payment_status: { query: { useQuery: false } },
          economy_funding_resolutions: { query: { useQuery: false } },
          economy_usage_purchase_quote: { query: { useQuery: false } },
        },
        mutator: {
          path: "src/lib/api/mutator.ts",
          name: "customInstance",
        },
      },
    },
  },
});
