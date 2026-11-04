import logging
from django.conf import settings
from procrastinate.contrib.django import app

from dj.apps.jobs.priorities import RECOVERY

logger = logging.getLogger(__name__)


@app.task(name='exports.export_publication', queue='exports', retry=False)
def export_publication_task(job_id: str):
    """Execute publication export generation."""
    from .exporter import process_export_job
    process_export_job(job_id)


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
