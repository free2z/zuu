/**
 * Browser-side calls for the KYC intake flow.
 *
 * Why hand-rolled `apiFetch` and not the generated orval client: the two
 * document endpoints are `multipart/form-data`, and orval models a file field
 * as a `string`, so the generated mutation cannot carry a `File`. The JSON
 * endpoints could use the generated functions, but keeping all seven in one
 * place — with one error shape — is worth more than the generated wrapper.
 * The types they exchange ARE the generated ones (`BasicInfo`,
 * `IdentityDocuments`, ...), which is what the schema work in this PR bought.
 *
 * `apiFetch` supplies `credentials: include` and the `X-CSRFToken` header.
 *
 * **On uploads and the gunicorn worker:** these POSTs stream through nginx into
 * the single synchronous Django worker, which is not where you want a 10MB
 * body. The obvious fix is a signed URL straight to Cloud Storage, and it is
 * NOT available: no endpoint mints one, the pods authenticate via Workload
 * Identity with no key to sign with (a `blob.generate_signed_url` would need
 * `iam.serviceAccountTokenCreator` granted first), and the CSP `connect-src` in
 * `k8s/free2z/backend-config.yaml` does not include `storage.googleapis.com`,
 * so the browser could not reach the bucket even holding a valid URL. That is
 * three separate pieces of infrastructure work; it is called out in the PR
 * rather than half-built here. What this file does do is keep each upload to a
 * single small file (10MB cap, one field at a time) instead of batching the
 * whole application into one request.
 */
import { apiFetch } from "$lib/api/config";
import { readErrorDetail } from "./uploads.js";

/** An API call that failed, carrying whatever the server said about it. */
export class KycRequestError extends Error {
  /**
   * @param {number} status
   * @param {string} detail server-supplied text, may be empty
   */
  constructor(status, detail) {
    super(detail || `KYC request failed with status ${status}`);
    this.name = "KycRequestError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(path, init) {
  const response = await apiFetch(path, init);

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new KycRequestError(response.status, readErrorDetail(body));
  }

  if (response.status === 204) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @param {{isUs: boolean|null, isIndividual: boolean|null}} answers
 * @returns {Promise<import("$lib/api/f2z.schemas").BasicInfo>}
 */
export function saveBasicInfo({ isUs, isIndividual }) {
  return request("/api/kyc/user-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_us: isUs, is_individual: isIndividual }),
  });
}

/** @returns {Promise<import("$lib/api/f2z.schemas").TaxFormFile>} */
export function fetchTaxFormFile() {
  return request("/api/kyc/get-tax-form-file", { method: "GET" });
}

/**
 * @param {File} file
 * @returns {Promise<import("$lib/api/f2z.schemas").TaxFormUploadResponse>}
 */
export function uploadTaxForm(file) {
  const body = new FormData();
  body.append("file", file);
  // No Content-Type header: the browser must set the multipart boundary.
  return request("/api/kyc/upload-tax-form", { method: "POST", body });
}

export function deleteTaxForm() {
  return request("/api/kyc/delete-tax-form", { method: "DELETE" });
}

/** @returns {Promise<import("$lib/api/f2z.schemas").IdentityDocuments>} */
export function fetchIdentityDocuments() {
  return request("/api/kyc/identity-documents", { method: "GET" });
}

/**
 * @param {"id_front"|"id_back"|"additional_document"|"live_photo"} field
 * @param {File} file
 * @returns {Promise<import("$lib/api/f2z.schemas").IdentityDocuments>}
 */
export function uploadIdentityDocument(field, file) {
  const body = new FormData();
  body.append(field, file);
  return request("/api/kyc/identity-documents", { method: "POST", body });
}

/**
 * @param {"id_front"|"id_back"|"additional_document"|"live_photo"} docType
 * @returns {Promise<import("$lib/api/f2z.schemas").IdentityDocuments>}
 */
export function deleteIdentityDocument(docType) {
  return request("/api/kyc/identity-documents", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_type: docType }),
  });
}

/**
 * @param {string} signature
 * @returns {Promise<{tax_form_signature: string}>}
 */
export function saveSignature(signature) {
  return request("/api/kyc/tax-form-signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tax_form_signature: signature }),
  });
}

/**
 * Submit for human review (NEW -> PENDING), or reopen an approved application
 * (APPROVED -> NEW). The server decides which; there is no way to ask for a
 * particular transition, and in particular no client path to APPROVED.
 *
 * @returns {Promise<import("$lib/api/f2z.schemas").ApplicationStatusChange>}
 */
export function changeApplicationStatus() {
  return request("/api/kyc/change-status", { method: "POST" });
}
