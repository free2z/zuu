import { json } from "@sveltejs/kit";
import * as env from "$app/env/public";
import * as privateEnv from "$app/env/private";
import type { RequestHandler } from "./$types";

// Liveness + deployed-commit probe for the  CI/CD pipeline.
//
// Two gates read this:
//   * main-integration.yml polls it on stage.free2z.cash and only promotes a
//     commit to prod once /healthz reports that exact SHA — so a slow or
//     failed stage deploy can never let an un-smoke-tested commit through.
//   * cloudbuild's prod-healthcheck polls it on free2z.cash after a prod
//     deploy and rolls back if it never reports the deployed $COMMIT_SHA.
//
// PUBLIC_BUILD_SHA is stamped into the deployment by bazel-apply (see
// k8s/new-ui/deployment.yaml); it is empty in local dev. No backend calls,
// no auth, no DB: this must stay cheap and always-up so it reflects the
// SvelteKit node server itself, not downstream health.
export const GET: RequestHandler = () => {
  return json(
    {
      ok: true,
      commit: env.PUBLIC_BUILD_SHA || "dev",
      deployment_commit: privateEnv.DEPLOYMENT_SHA || "dev",
      release_id: privateEnv.APP_RELEASE_ID || "dev",
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
};
