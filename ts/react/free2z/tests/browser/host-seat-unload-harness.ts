import axios from "axios";
import Cookies from "js-cookie";
import { createHostSeat } from "../../src/hostSeat";
import {
  registerHostSeat,
  retainHostSeat,
  releaseHostSeat,
} from "../../../../../wallet/free2z/src/lib/api/host-seat";
import {
  getTokenSnapshot,
  request,
  setToken,
} from "../../../../../wallet/free2z/src/lib/api/http";

// Exercise shipping lease and transport code with a synthetic SDK boundary.
// The classic application's cookie/CSRF setup is retained for the real HTTP calls.
axios.defaults.withCredentials = true;
axios.interceptors.request.use((config) => {
  const csrf = Cookies.get("csrftoken");
  if (csrf && config.headers) config.headers["X-CSRFToken"] = csrf;
  return config;
});
const state = { ready: false, error: false, close: () => {}, session: "" };
(window as any).hostContract = state;
if (new URL(location.href).searchParams.get("surface") === "native") {
  setToken("synthetic-native-owner");
  const seat = registerHostSeat("Alice", 41, getTokenSnapshot());
  state.session = seat.session;
  state.close = () => releaseHostSeat(seat);
  window.addEventListener("pagehide", state.close);
  void request("/api/dyte/Alice/ppv", {
    method: "POST",
    body: { role: "host", host_session: seat.session, expected_actor_id: 41 },
  })
    .then(() => {
      retainHostSeat(seat, () => {
        state.error = true;
      });
      state.ready = true;
    })
    .catch(() => {
      state.error = true;
    });
} else {
  const host = createHostSeat({
    username: "Alice",
    actorId: 41,
    type: "ppv",
    price: "23.00",
    isCurrent: () => true,
    isIntentCurrent: () => true,
    initialize: async () => ({
      leave: async () => {},
      self: { on: () => {}, removeListener: () => {} },
    }),
    onReady: () => {
      state.ready = true;
    },
    onError: () => {
      state.error = true;
    },
    onLost: () => {
      state.error = true;
    },
    onClosed: () => {},
  });
  host.retain();
  state.close = () => host.close();
}
