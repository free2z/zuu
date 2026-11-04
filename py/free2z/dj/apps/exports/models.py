import uuid
from django.conf import settings
from django.db import models
from django.utils import timezone


class ExportStatus(models.TextChoices):
    QUEUED = 'queued', 'Queued'
    RUNNING = 'running', 'Running'
    READY = 'ready', 'Ready'
    FAILED = 'failed', 'Failed'
    EXPIRED = 'expired', 'Expired'


class PublicationExportJob(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        # Account deletion must not cascade away the only record that can
        # discover and expire a private archive in storage. SET_NULL keeps the
        # cleanup record while allowing the account deletion to complete.
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='publication_export_jobs',
    )
    status = models.CharField(
        max_length=16,
        choices=ExportStatus.choices,
        default=ExportStatus.QUEUED,
        db_index=True,
    )
    complete = models.BooleanField(
        default=False,
        help_text="Whether the export completed without missing assets or unsupported directives.",
    )
    warnings = models.JSONField(
        default=list,
        blank=True,
        help_text="Explicit list of user-safe warnings encountered during export generation.",
    )
    error_message = models.TextField(
        blank=True,
        help_text="User-safe failure details if the export job failed.",
    )
    file_path = models.CharField(
        max_length=512,
        blank=True,
        help_text="Internal storage key in private export storage.",
    )
    file_name = models.CharField(
        max_length=255,
        blank=True,
        help_text="Stable filename for Content-Disposition attachment download.",
    )
    file_size = models.BigIntegerField(
        null=True,
        blank=True,
        help_text="Size of completed archive in bytes.",
    )
    checksum_sha256 = models.CharField(
        max_length=64,
        blank=True,
        help_text="SHA-256 hex digest of the completed archive ZIP file.",
    )
    article_count = models.PositiveIntegerField(
        default=0,
        help_text="Number of articles included in the export.",
    )
    asset_count = models.PositiveIntegerField(
        default=0,
        help_text="Number of distinct media assets bundled in the export.",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        verbose_name = "Publication Export Job"
        verbose_name_plural = "Publication Export Jobs"
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['creator', 'status', '-created_at'], name='exports_pub_creator_stat_idx'),
            models.Index(fields=['status', 'expires_at'], name='exports_pub_stat_exp_idx'),
        ]
        constraints = [
            # Enforce at most one active (queued/running) publication export job per creator.
            models.UniqueConstraint(
                fields=['creator'],
                condition=models.Q(status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING]),
                name='unique_active_publication_export_job',
            ),
        ]

    def __str__(self):
        return f"PublicationExportJob({self.id}, creator={self.creator_id}, status={self.status})"

    @property
    def is_expired(self) -> bool:
        if self.status == ExportStatus.EXPIRED:
            return True
        if self.expires_at and timezone.now() >= self.expires_at:
            return True
        return False
