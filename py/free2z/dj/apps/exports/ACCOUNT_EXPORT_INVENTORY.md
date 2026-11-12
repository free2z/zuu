# Account export coverage (issue #1304)

This inventory describes an intentionally partial archive. The
account export admission and UI remain disabled. Existing production archives
and all old readers must be inventoried and old readers drained before enabling
it: an older publication download handler can serve an account archive without
its newer authentication checks.

| Data | Current archive | Limits and gaps |
| --- | --- | --- |
| Profile | `profile.json` | Creator public profile fields and balances, plus Email notification/publicity settings in `email_preferences.jsonl`; confirmation tokens and staff/security/deletion state are excluded. Avatar/banner binary references are not guaranteed. |
| Pages and publications | `publications.zip` | Existing publication exporter; check its manifest and warnings for missing assets. |
| Comments | `comments.jsonl` | Authored visible and moderated comments; context and other account activity need review. |
| 2Z ledger | `ledger.jsonl` | Owner user/debt legs; peer IDs, references and metadata deliberately redacted. Earnings, payout, hold and cap summaries are in `earnings.jsonl`; provider secrets and other-party metadata remain excluded. |
| Purchases | `purchases.jsonl`, `purchase_receipts.jsonl` | Owner purchase intents and receipts; provider secrets and raw receipts omitted. Legacy Stripe transactions, checkout intents, ZEC credit receipts, pending notices and creator-attributed legacy Zcash transaction summaries are in `legacy_purchases.jsonl`; outgoing and active incoming subscriptions are in `relationships.jsonl`. |
| Connected applications | `connected_apps.jsonl` | OAuth app authorizations and their scopes/caps; tokens and secrets excluded. Owned app definitions, MCP connections and owner grants are in `owned_apps.jsonl`, `mcp_connections.jsonl` and `mcp_grants.jsonl`. |
| Uploads | `uploads.jsonl`, `owned_media/` | Owner files and variants are copied into `owned_media/`; `uploads.jsonl` identifies unavailable or shared objects individually. |
| Social and relationships | `relationships.jsonl`, `identities.jsonl` | Outgoing follows, blocks, mutes and subscriptions are in `relationships.jsonl`; own provider identity metadata is in `identities.jsonl`. Other-party private state and OAuth secrets are excluded. |
| Messages and activity | `content.jsonl`, `activity.jsonl` | Stories, own personas and prompts are in `content.jsonl`; recipient notifications are in `activity.jsonl`. Chat request role/time and sender charge, and the caller’s report details, are included; other-party information, staff notes and private targets are excluded. |
| KYC, tax and addresses | `identities.jsonl`, `owned_media/` | KYC application metadata and W9/W8BEN owner-entered fields are in `identities.jsonl`; owner-exclusive identity and tax files are in `owned_media/`, with individual unavailable/shared warnings in `uploads.jsonl`. Tax CostBasis and TaxEvent have no Creator ownership relation. |
| Credentials, sessions and operational data | Omitted | Password hashes, OTP secrets, tokens, signing keys, active sessions, authorization codes, internal audit/security records and job infrastructure are not portable account content. |

The model-by-model inventory in `project_model_census.json` records each loaded project model, concrete fields and relationship targets, its owner path or shared/system classification, and current treatment. Conditional paths name multiple roles without assigning one person another person’s data. Omitted account data remains omitted and is not represented as an approved product policy.

The checked-in `project_model_census.json` captures every loaded `dj.apps` model, its concrete fields and relation targets. A test rejects new models, fields and changed relation targets. `account_relation_census.json` separately identifies direct Creator relations. The census describes scalar and indirect paths where identifiable; it does not assert ownership of records merely because they reference an account.
