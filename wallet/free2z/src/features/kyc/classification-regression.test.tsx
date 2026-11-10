// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BasicInfoStep } from "./steps/BasicInfoStep";
import { TaxFormStep } from "./steps/TaxFormStep";
import { ReviewStep } from "./steps/ReviewStep";
import { kyc } from "@/lib/api/free2z";
import type { KycProfile } from "@/lib/api/types";

vi.mock("@/lib/api/free2z", () => ({
  kyc: {
    saveProfile: vi.fn(),
    uploadTaxForm: vi.fn(),
    getProfile: vi.fn(),
    signTaxForm: vi.fn(),
    submit: vi.fn(),
  },
}));
const api = vi.mocked(kyc);
const initial: KycProfile = {
  is_us: true,
  is_individual: true,
  application_status: "NEW",
  tax_form_classification: "W-9",
  tax_form_version: 1,
};
let profile = initial;
let file: string | null = "/old-w9.pdf";
let signature: string | null = "Ada Lovelace";
let step = 0;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

function render() {
  root.render(
    step === 0 ? (
      <BasicInfoStep
        profile={profile}
        onNext={(next) => {
          const changed =
            next.is_us !== profile.is_us ||
            next.is_individual !== profile.is_individual;
          if (changed) {
            file = null;
            signature = null;
          }
          profile = next;
          step = 1;
          render();
          if (changed)
            void Promise.all([api.getProfile()])
              .then(([fresh]) => {
                profile = fresh;
                render();
              })
              .catch(() => {
                file = null;
                signature = null;
              });
        }}
      />
    ) : step === 1 ? (
      <TaxFormStep
        profile={profile}
        fileUrl={file}
        signature={signature}
        onProfileUpdated={(p) => {
          profile = p;
        }}
        onNext={(u, s) => {
          file = u;
          signature = s;
          step = 2;
          render();
        }}
        onBack={() => {
          step = 0;
          render();
        }}
      />
    ) : (
      <ReviewStep
        profile={profile}
        docs={{ id_front_url: "/id", live_photo_url: "/photo" }}
        taxFormUrl={file}
        signature={signature}
        taxFormPrecondition={{
          tax_form_version: profile.tax_form_version,
          tax_form_classification: "W-8BEN",
        }}
        onBack={() => {
          step = 1;
          render();
        }}
        onSubmitted={() => {}}
      />
    ),
  );
}
const click = async (name: string) => {
  const b = [...host.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === name,
  );
  if (!b) throw new Error(`missing ${name}`);
  await act(async () => b.click());
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  profile = initial;
  file = "/old-w9.pdf";
  signature = "Ada Lovelace";
  step = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.saveProfile.mockResolvedValue({
    ...initial,
    is_us: false,
    tax_form_classification: "W-8BEN",
    tax_form_version: 2,
  });
  api.getProfile.mockResolvedValue({
    ...initial,
    is_us: false,
    tax_form_classification: "W-8BEN",
    tax_form_version: 2,
  });
  api.submit.mockResolvedValue();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("drops signed W-9 on classification change and blocks review until replacement is re-signed", async () => {
  await act(async () => render());
  await click("Non-US");
  await click("Continue");
  await act(async () => Promise.resolve());
  expect(host.textContent).toContain("W-8BEN");
  const input = host.querySelector('input[type="file"]')!;
  const chosen = new File(["pdf"], "form.pdf", { type: "application/pdf" });
  api.uploadTaxForm.mockResolvedValue({
    file_url: "/new-w8.pdf",
    tax_form_version: 3,
  });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [chosen] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.uploadTaxForm).toHaveBeenCalledWith(chosen, {
    tax_form_version: 2,
    tax_form_classification: "W-8BEN",
  });
  expect(host.textContent).not.toContain("Ada Lovelace");
  step = 2;
  await act(async () => render());
  let submit = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Submit application"),
  )!;
  expect(submit.disabled).toBe(true);
  file = "/new-w8.pdf";
  await act(async () => render());
  submit = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Submit application"),
  )!;
  expect(submit.disabled).toBe(true);
  signature = "Ada Lovelace";
  await act(async () => render());
  submit = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Submit application"),
  )!;
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  expect(api.submit).toHaveBeenCalledWith({
    tax_form_version: 2,
    tax_form_classification: "W-8BEN",
  });
});
