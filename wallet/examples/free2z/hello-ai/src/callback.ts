import { completeBrowserSignIn } from "@free2z/sdk";
try {
  completeBrowserSignIn();
} catch {
  // Never render or log the callback URL (it contains an authorization code).
  document.querySelector("#callback-status")!.textContent =
    "Unable to reach the sign-in window. Close this tab and sign in again from the app.";
}
