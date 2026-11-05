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
| Series | Own series list; nested page members filter page creators. |
| Public AI conversations and public action | Filter conversation owner. |
| Public AI prompt responses | Filter response author and the requested conversation owner. |
| AI personalities | Filter creator on lists; system personalities have no creator. |
| Public live meetings and discovery | Filter creator before pagination and discovery limits. |
| Own AI conversations, stories and uploads | Owner-scoped lists. |
| Subscriber and subscription lists, payment transactions | Financial relationships and receipts remain visible. |
| AI model catalogue | System catalogue, not user-authored content. |

The DRF list-route census in `test_block_policy_inventory.py` requires an
explicit decision for each discovered list view. Behavioural tests in
`test_block_filtering.py` exercise the filters with real database rows.
