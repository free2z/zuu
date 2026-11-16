import { useEffect } from "react";
import { useQuery } from "react-query";
import axios from "axios";
import { getGlobalState, retireAuthSession, useGlobalState } from "./global";
import { retireResolvedSubscribeIdempotencyKeys } from "../subscribeIdempotency";

function fetchUserData() {
  // console.log('[GET auth/user] fetchUserData');
  return axios.get("/api/auth/user/").then((res) => res.data);
}

export default function GlobalCreator() {
  // const queryClient = useQueryClient();
  const [creator, setCreator] = useGlobalState("creator");
  const [authStatus, setAuthStatus] = useGlobalState("authStatus");

  const { data, error } = useQuery("creatorData", fetchUserData, {
    // no retry so we get the error on the first try
    retry: 0,
    // Refresh private caches on every authoritative response. Host ownership
    // survives ordinary balance/profile updates; changed identities are fenced
    // synchronously, before the effect below adopts their data.
    onSuccess: (data) => {
      const current = getGlobalState("creator");
      retireAuthSession({
        hostIdentityChanged:
          data.id !== current.id || data.username !== current.username,
      });
    },
  });

  useEffect(() => {
    if (error) {
      const status = (error as { response?: { status?: number } }).response
        ?.status;
      if (status !== 401 && status !== 403 && data) {
        // An unavailable profile read is not a logout. Invalidate private
        // caches without replacing the current identity with retained data.
        retireAuthSession({ hostIdentityChanged: false });
      } else {
        setAuthStatus(false);
      }
      return;
    }
    if (data) {
      // console.log("GLOBAL authstatus true")
      setAuthStatus(true);
      setCreator(data);
      // An ACTIVE membership resolves an outstanding subscribe
      // idempotency key, and this is the only place in the classic app
      // that always sees the authoritative list -- the subscribe dialog
      // is not mounted while the fan is subscribed. A purchase whose
      // response was lost otherwise strands its key, and the receipt
      // binds that key to the price paid: after the membership expires
      // and the creator moves their price, every new attempt is a
      // permanent 409 idempotency_mismatch (codex adversarial review of
      // ). Retirement is on resolution, never on a clock.
      // The payer is passed because localStorage is per BROWSER:
      // another account's membership must not retire this one's
      // outstanding purchase. See the helper.
      retireResolvedSubscribeIdempotencyKeys(
        data.stars,
        data.id,
        data.star_ids,
        data.username
      );
    }
    // console.log("GLOBAL CREATOR USEEFFECT")
    // console.log("data", data)
    // console.log("error", error)
  }, [data, error]);

  return null;
}
