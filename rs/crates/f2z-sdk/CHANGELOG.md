# Changelog

## 0.1.0 — unreleased

Initial reviewed SDK contract implementation. Publication is disabled pending
release acceptance; see the repository SDK release guide.

- `SignInOptions::spend_cap` / `with_spend_cap(SpendCapHint)` and `CapPeriod`:
  an optional, additive suggested spend cap sent as `f2z_spend_cap` /
  `f2z_spend_period`. Only pre-selects the consent screen.
