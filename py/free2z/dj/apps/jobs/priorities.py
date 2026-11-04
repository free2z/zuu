"""Named Procrastinate priorities shared by queue producers and tasks.

Procrastinate fetches higher priorities first. Keep user-facing work ahead of
maintenance and bulk repair work. Export cleanup uses RECOVERY between
INTERACTIVE and DEFAULT: expired archives and abandoned jobs need timely
recovery, while interactive work remains first. Priority orders eligible jobs;
it cannot preempt a running job or guarantee fairness under sustained load.
Backfill schedule pacing is not an execution-rate limit after downtime.
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
