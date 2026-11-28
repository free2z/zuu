import logging
from django.conf import settings
from procrastinate import RetryStrategy
from procrastinate.contrib.django import app

from dj.apps.jobs.priorities import RECOVERY

logger = logging.getLogger(__name__)

ACCOUNT_EXPORT_QUEUE = 'account-exports-v1'
ACCOUNT_EXPORT_PAUSE_RETRY_SECONDS = 6 * 60 * 60


class AccountExportAdmissionClosed(Exception):
    """Retry a queued account archive later without reading or changing it."""


ACCOUNT_EXPORT_RETRY = RetryStrategy(
    wait=ACCOUNT_EXPORT_PAUSE_RETRY_SECONDS,
    retry_exceptions=(AccountExportAdmissionClosed,),
)


@app.task(name='exports.export_publication', queue='exports', retry=False)
def export_publication_task(job_id: str):
    """Execute publication export generation."""
    from .exporter import process_export_job
    process_export_job(job_id)


@app.task(name='exports.export_account_data_v1', queue=ACCOUNT_EXPORT_QUEUE, retry=ACCOUNT_EXPORT_RETRY)
def export_account_data_task(job_id: str):
    """Execute an admitted full-account export; otherwise preserve it for retry."""
    from . import rollout
    if not rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED:
        logger.warning(
            "Account export task %s deferred: account export admission is closed.",
            job_id,
        )
        raise AccountExportAdmissionClosed("Account export admission is closed.")
    from .exporter import process_export_job
    process_export_job(job_id, expected_type='account')


@app.periodic(cron=getattr(settings, 'PUBLICATION_EXPORT_SWEEP_CRON', '*/30 * * * *'), priority=RECOVERY)
@app.task(name='exports.cleanup_expired_exports', queue='default', retry=False, priority=RECOVERY)
def cleanup_expired_exports_task(timestamp: int = 0):
    """Periodic sweep cleaning expired archives and abandoned jobs.

    Bounded at settings.EXPORT_CLEANUP_BATCH rows per tick: every
    row costs one remote storage delete and this runs on the catch-all
    `default` queue, so an uncapped backlog is an uncapped hold on that
    lane. A backlog that the cap did not clear is reported at WARNING --
    the task is retry=False and periodic, so without that line a sweep
    permanently falling behind looks identical to a sweep with nothing to
    do.
    """
    from .exporter import cleanup_expired_jobs
    cleaned, remaining = cleanup_expired_jobs(
        limit=settings.EXPORT_CLEANUP_BATCH)
    if cleaned > 0:
        logger.info("Cleaned %d expired/abandoned publication export jobs.", cleaned)
    if remaining > 0:
        logger.warning(
            "Publication export cleanup backlog: cleaned=%d remaining=%d "
            "batch=%d; next sweep on %s",
            cleaned, remaining, settings.EXPORT_CLEANUP_BATCH,
            getattr(settings, 'PUBLICATION_EXPORT_SWEEP_CRON', '*/30 * * * *'),
        )
