import axios from "axios";
import { lazy, useEffect, useState } from "react";
import { useParams } from "react-router";
import CreatorDetail, { PublicCreator } from "./CreatorDetail";
import PageDetail from "./PageDetail";
// https://reactjs.org/docs/code-splitting.html
// import Global404 from "./Global404"
const Global404 = lazy(() => import("./Global404"));

type ResolutionFailure = "" | "not-found" | "retryable";
type ResolutionType = "" | "zpage" | "creator";

type RouteResolution = {
  routeKey: string;
  type: ResolutionType;
  creator: PublicCreator | null;
  failure: ResolutionFailure;
};

const EMPTY_RESOLUTION: RouteResolution = {
  routeKey: "",
  type: "",
  creator: null,
  failure: "",
};

export function resolutionForRoute(
  resolution: RouteResolution,
  routeKey: string,
): RouteResolution {
  return resolution.routeKey === routeKey ? resolution : EMPTY_RESOLUTION;
}

function responseStatus(reason: unknown): number | undefined {
  const error = reason as {
    status?: number;
    response?: { status?: number };
  };
  return error?.response?.status ?? error?.status;
}

export default function RootSplitter() {
  const params = useParams();
  const [retryKey, setRetryKey] = useState(0);
  const routeId = params.id ?? "";
  // React Router decodes params before returning them. Encode the identifier
  // again so an input such as `..%2Fauth%2Fuser` cannot normalize either
  // credentialed axios request outside its intended API namespace.
  const encodedRouteId = encodeURIComponent(routeId);
  const routeKey = JSON.stringify([routeId, retryKey]);
  const [routeResolution, setRouteResolution] =
    useState<RouteResolution>(EMPTY_RESOLUTION);
  // Passive effects run after paint. Never expose the previous route's
  // creator, article, or failure while the replacement request is pending.
  const { type, creator, failure } = resolutionForRoute(
    routeResolution,
    routeKey,
  );

  useEffect(() => {
    let active = true;

    async function resolveRoot() {
      try {
        // Creator profiles are the common case and do not need the
        // scan-capable historic identifier resolver. Keeping them off
        // `/api/get-type/` means its small nginx bucket cannot turn a
        // shared-NAT creator visit into a false 404.
        const response = await axios.get(`/api/creator/${encodedRouteId}/`);
        if (active) {
          setRouteResolution({
            routeKey,
            type: "creator",
            creator: response.data,
            failure: "",
          });
        }
        return;
      } catch (reason) {
        if (!active) return;
        if (responseStatus(reason) !== 404) {
          setRouteResolution({
            routeKey,
            type: "",
            creator: null,
            failure: "retryable",
          });
          return;
        }
      }

      try {
        const response = await axios.get(`/api/get-type/${encodedRouteId}`);
        if (!active) return;
        if (response.data === "creator" || response.data === "zpage") {
          setRouteResolution({
            routeKey,
            type: response.data,
            creator: null,
            failure: "",
          });
        } else {
          setRouteResolution({
            routeKey,
            type: "",
            creator: null,
            failure: "not-found",
          });
        }
      } catch (reason) {
        if (!active) return;
        setRouteResolution({
          routeKey,
          type: "",
          creator: null,
          failure: responseStatus(reason) === 404 ? "not-found" : "retryable",
        });
      }
    }

    void resolveRoot();
    return () => {
      active = false;
    };
  }, [encodedRouteId, routeKey]);

  if (failure === "not-found") {
    return <Global404 />;
  }
  if (failure === "retryable") {
    return (
      <div role="alert">
        <p>This page is temporarily unavailable. Please try again.</p>
        <button type="button" onClick={() => setRetryKey((key) => key + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!type) {
    return null;
  }

  if (type === "zpage") {
    // The explicit legacy /:username/zpage/:id route names an owner as well
    // as an identifier. Preserve that trust boundary just like the canonical
    // two-segment route; the detail API resolves vanities globally.
    return <PageDetail expectedCreator={params.username} />;
  }

  if (type === "creator" && creator) {
    return <CreatorDetail initialCreator={creator} />;
  }

  return null;
}
