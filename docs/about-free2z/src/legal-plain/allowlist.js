/**
 * Documents served by the plain legal endpoint for application sign-up links.
 * Include consumer Terms, Privacy, and policy pages without commerce content.
 * Purchase, payment, Zcash, and creator-earnings documents have separate routes.
 * The rendered-text check rejects purchase vocabulary outside explicit legal
 * phrases and verifies that only these documents are emitted.
 */
module.exports = Object.freeze([
  "01-terms-of-service-agreement.md",
  "02-privacy-policy.md",
  "03-user-content-agreement.md",
  "09-ip-rights-policy.md",
]);
