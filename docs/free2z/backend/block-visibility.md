# Free2Z block visibility

A block is directional: list responses for the blocker omit the blocked
account's content before pagination. Anonymous readers, bystanders and the
blocked account retain their ordinary visibility. Direct profile and page
links remain usable for management; blocking does not delete a follow or
change a permission. Money receipts are retained. `blocks/mine` and the
creator block toggle are scoped to the authenticated caller.

| Surface | Policy |
| --- | --- |
| `/api/zpage/` and related pages | Filter page creator; owner dashboard is scoped to the caller. |
| `/api/creator/` | Filter creator; direct profiles remain accessible. |
| `/api/comments/`, replies and comments for an object | Filter comment author. |
| `/api/events/` and unread counts | Filter blocked contributors for contact events; retain money receipts. |
| `/api/g12f/follows/mine/` | Filter followed creator without deleting the relationship. |
| `/api/g12f/blocks/mine/` | Own block-management list, including blocked creators. |
| Series | Own series list and public series members filter page creators. An editor cannot replace a series while it has hidden members, preserving their memberships. |
| Public AI conversations and public action | Filter conversation owner. |
| Public AI prompt responses | Filter response author and the requested conversation owner. |
| AI personalities | Filter creator on lists; system personalities have no creator. |
| Public live meetings and discovery | Filter creator before pagination and discovery limits. |
| Own AI conversations, stories and uploads | Owner-scoped lists. |
| Subscriber and subscription lists, payment transactions | Financial relationships and receipts remain visible. |
| AI model catalogue | System catalogue, not user-authored content. |
| Global and per-user RSS: zPages, podcasts, Converse and AI | Session viewer's blocks filter authors before the feed limit. Anonymous requests keep public visibility. Responses are private, no-store, and vary by Cookie and Authorization. AI descriptions also filter transcript authors. |
| Page translation variant actions | Variants of a directly requested page; direct object access remains available. |
| Creator block, mute and follow actions | Caller-owned relationship state and counts; management remains accessible. |

The route census in `test_block_policy_inventory.py` discovers DRF list views,
custom GET actions and Django syndication feed handlers from the URLconf and
requires an explicit decision for each. Each content policy is bound to a
database-backed behavioral probe which must actually request its registered
route; owner, financial, system and direct-object exemptions are explicit.
Negative controls cover a classified but unfiltered route and removal of an
existing filter. The census does not discover arbitrary non-DRF handlers that
are not Django `Feed` instances.
