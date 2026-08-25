import * as api from "./tauri";
import { useWalletStore } from "../store/wallet";
import {
  CreatedSeedSession,
  SensitiveSeedSession,
  type SensitiveSeedAuthority,
} from "./sensitive-seed-session";

export {
  CreatedSeedSession,
  SensitiveSeedSession,
  type SensitiveSeedAuthority,
} from "./sensitive-seed-session";

export const sensitiveSeedAuthority: SensitiveSeedAuthority = {
  begin: () => api.beginSensitiveDisplay().then(({ token }) => token),
  end: (token) => api.endSensitiveDisplay(token, "seedReveal"),
};

// Creation starts in Welcome and renders on a different page. This module-
// owned session keeps the lease alive across that route transition.
export const createdSeedSession = new CreatedSeedSession(
  new SensitiveSeedSession(sensitiveSeedAuthority, (phrase) =>
    useWalletStore.getState().setSeedPhrase(phrase),
  ),
);
