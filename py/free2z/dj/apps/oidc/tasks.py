"""Periodic hygiene: sweep expired codes and tokens.

``oauth2_provider.models.clear_expired`` is the library's sweep, run here on
the worker's periodic scheduler rather than as a CronJob ``manage.py
cleartokens``, following the repo's procrastinate convention (a periodic,
``retry=False`` task on the catch-all queue; the next tick is its retry).

**What it keeps, and for how long -- the retention that reuse detection
depends on.** A rotated refresh token is *revoked* rather than deleted, and
that revoked row is the evidence that a later presentation of it is reuse
(spec §8). ``clear_expired`` deletes a revoked refresh token only once it is
older than ``REFRESH_TOKEN_EXPIRE_SECONDS`` (30 days) -- the lifetime the
token would have had -- so the evidence outlives every token it could
condemn. Live refresh tokens go when their access token has been expired for
30 days; access and ID tokens go when expired; redeemed and unredeemed
authorization codes go when expired (60 s), which is the window in which a
replay of a redeemed code still revokes its first redemption's tokens
(``validators.validate_code``). Nothing here changes what a request is
refused for: every refusal is decided at use time from the rows that exist,
and this only removes rows nothing can accept any more.

Security does not depend on it running: a missed tick leaves dead rows in
place, all of which are already refused.
"""
from __future__ import annotations

import logging

from django.conf import settings
from procrastinate.contrib.django import app

logger = logging.getLogger(__name__)

DEFAULT_SWEEP_CRON = "17 * * * *"


@app.periodic(cron=getattr(settings, "OIDC_TOKEN_SWEEP_CRON", DEFAULT_SWEEP_CRON))
@app.task(name="oidc.sweep_tokens", queue="default", retry=False)
def sweep_tokens(timestamp: int = 0):
    from oauth2_provider.models import clear_expired

    from dj.apps.identity.models import AuthContext

    clear_expired()
    # Login now produces AuthContexts. Reuse this existing hourly
    # task: bounded batches keep naturally expired credentials from leaving
    # rows forever, without monopolizing a worker during a large backlog.
    contexts_deleted = 0
    for _ in range(10):
        deleted = AuthContext.objects.purge_expired(batch_size=1000)
        contexts_deleted += deleted
        if deleted < 1000:
            break
    logger.info("oidc: expired codes, tokens and %s auth contexts swept", contexts_deleted)


#Every 5 minutes, off the minute the other sweeps share. The task shipped
#registered-but-unscheduled one release earlier, so every worker
#lane already knows it when this schedule starts producing it (register
#first, produce second: CLAUDE.md, /).
DEFAULT_AI_REPORT_SURGE_CRON = "2-59/5 * * * *"


@app.periodic(
    cron=getattr(settings, "OIDC_AI_REPORT_SURGE_CRON", DEFAULT_AI_REPORT_SURGE_CRON),
    queueing_lock="oidc.reevaluate_ai_report_surges",
)
@app.task(name="oidc.reevaluate_ai_report_surges", queue="default", retry=False)
def reevaluate_ai_report_surges(timestamp: int = 0):
    """Re-judge the AI-output-report page for apps with recent unsafe
    reports (dj.apps.oidc.ai_reports.reevaluate_surges; tuzi#2654)."""
    from .ai_reports import reevaluate_surges

    evaluated = reevaluate_surges()
    logger.info("oidc: AI output report surge re-evaluated for %s app(s)", evaluated)
