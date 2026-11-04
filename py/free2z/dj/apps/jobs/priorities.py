"""Named Procrastinate priorities shared by queue producers and tasks.

Procrastinate fetches higher priorities first. Keep user-facing work ahead of
maintenance and bulk repair work so a large, deliberately paced backfill can
never take the shared worker away from interactive requests.
"""

INTERACTIVE = 100
RECOVERY = 50
DEFAULT = 0
BACKGROUND = -10
MAINTENANCE = -20
BACKFILL = -100


PRIORITY_LADDER = (
    INTERACTIVE,
    RECOVERY,
    DEFAULT,
    BACKGROUND,
    MAINTENANCE,
    BACKFILL,
)

assert all(left > right for left, right in zip(
    PRIORITY_LADDER, PRIORITY_LADDER[1:]))
