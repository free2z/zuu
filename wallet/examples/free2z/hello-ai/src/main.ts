import {
  Client,
  FetchTransport,
  NativeTransport,
  SdkError,
  formatMilli2z,
  type ReportReason,
} from "@free2z/sdk";
import { HelloAI, browserJournal, type View } from "./controller.js";
import "./style.css";

const clientId = import.meta.env.VITE_F2Z_CLIENT_ID as string | undefined;
const redirectUri = import.meta.env.VITE_F2Z_REDIRECT_URI as string | undefined;
const native = import.meta.env.MODE === "tauri";
const billingAllowed = import.meta.env.VITE_F2Z_ALLOW_BILLING_LINK === "true";
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const button = (id: string) => $<HTMLButtonElement>(id);
const showError = (error: unknown) => {
  $("status").textContent =
    error instanceof SdkError
      ? `${error.code}. No automatic paid retry.`
      : "Local configuration or storage error; no automatic paid retry.";
};

async function start() {
  if (!clientId || clientId === "YOUR_REGISTERED_PUBLIC_CLIENT_ID")
    throw new Error("Configure a registered public client ID");
  // Native is selected at BUILD time. Never fall back to browser auth when
  // IPC fails or infer privileged mode by probing Tauri's private globals.
  const transport = native
    ? new NativeTransport(
        (await import("@free2z/tauri-plugin-f2z-api")).nativeBridge,
      )
    : new FetchTransport({
        clientId,
        redirectUri:
          redirectUri ??
          (() => {
            throw new Error("Configure an exact callback URI");
          })(),
        allowInsecureLoopback: import.meta.env.DEV,
        openExternal: async (url) => {
          // Preserve this app and its memory-only session while billing opens.
          const opened = window.open(url, "_blank", "noopener,noreferrer");
          // noopener may return null even when it succeeds; do not retry.
          void opened;
        },
      });
  const client = new Client(transport);
  const render = (view: View) => {
    const signed = view.session.signedIn;
    $("identity").textContent = signed
      ? `${view.session.preferredUsername ?? "Free2Z account"} · ${view.session.persistence === "memory_only" ? "Memory only: reload/restart requires sign-in" : "OS credential storage"}`
      : "Signed out";
    $("balance").textContent = view.balance
      ? `Available: ${formatMilli2z(view.balance.available_milli_2z)} 2Z · Held: ${formatMilli2z(view.balance.held_milli_2z)} 2Z · Debt: ${formatMilli2z(view.balance.debt_milli_2z)} 2Z`
      : "Balance not loaded";
    const select = $<HTMLSelectElement>("model"),
      previous = select.value;
    select.replaceChildren(
      ...view.models.map((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.display_name ?? model.id;
        return option;
      }),
    );
    if (view.models.some((m) => m.id === previous)) select.value = previous;
    $("status").textContent = view.status;
    // Never render generated text or provider errors as HTML in a privileged window.
    $("answer").textContent = view.text;
    const charge = view.charge;
    $("charge").textContent =
      charge.state === "pending"
        ? "Final charge unknown; recover the receipt."
        : charge.state === "released"
          ? "Confirmed zero charge (released)."
          : `Charged: ${charge.charged2z.toString()} whole 2Z · Receipt: ${charge.receiptId}${charge.collectedMilli2z === undefined ? "" : ` · Collected: ${formatMilli2z(charge.collectedMilli2z)} 2Z`}${charge.shortfallMilli2z === undefined ? "" : ` · Shortfall: ${formatMilli2z(charge.shortfallMilli2z)} 2Z`}`;
    button("sign-in").disabled = view.busy;
    button("switch").disabled = view.busy || !signed;
    button("sign-out").disabled = !signed;
    button("send").disabled =
      view.busy ||
      !signed ||
      !view.session.grantedScopes.includes("ai:invoke") ||
      !view.models.length ||
      (!!view.entry && charge.state === "pending");
    button("recover").disabled = view.busy || !signed || !view.entry;
    button("cancel").disabled = !view.busy || view.authenticating;
    button("report").disabled = view.busy || !signed || !view.entry?.callId;
    button("refresh").disabled = view.busy || !signed;
  };
  const app = new HelloAI(
    client,
    browserJournal(sessionStorage, clientId),
    render,
  );
  const on = (id: string, action: () => Promise<unknown>) =>
    button(id).addEventListener("click", () => {
      void action().catch(showError);
    });
  on("sign-in", () => app.signIn());
  on("switch", () => app.signIn(true));
  on("sign-out", () => app.signOut());
  on("refresh", () => app.refresh());
  on("manage", () => client.openManageAccount());
  on("delete", () => client.openDeleteAccount());
  button("billing").hidden = !billingAllowed;
  if (billingAllowed) on("billing", () => client.openBilling());
  on("cancel", () => app.cancel());
  on("recover", () => app.recover());
  on("report", async () => {
    const callId = app.view.entry?.callId;
    if (!callId) return;
    await client.reportCall(
      callId,
      $<HTMLSelectElement>("reason").value as ReportReason,
    );
    $("status").textContent = "Thanks — reported.";
  });
  $("chat").addEventListener("submit", (event) => {
    event.preventDefault();
    void app
      .send(
        $<HTMLSelectElement>("model").value,
        $<HTMLTextAreaElement>("prompt").value,
      )
      .catch(showError);
  });
  // Returning from billing is only a wake-up hint; always re-read the ledger.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible")
      void app.refresh().catch(showError);
  });
  window.addEventListener("pagehide", () => {
    void app.cancel().catch(() => {});
  });
  await app.refresh();
}
void start().catch(showError);
