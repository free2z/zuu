from rest_framework import serializers
from drf_spectacular.utils import extend_schema_field
from .models import PublicationExportJob, ExportStatus


class PublicationExportJobSerializer(serializers.ModelSerializer):
    download_url = serializers.SerializerMethodField(
        help_text="Direct download URL for the archive ZIP, available when status is 'ready' and unexpired.",
    )
    is_expired = serializers.BooleanField(
        read_only=True,
        help_text="Whether the export artifact has reached its expiry timestamp.",
    )
    warnings = serializers.ListField(
        child=serializers.CharField(),
        read_only=True,
        help_text="Explicit list of user-safe warnings encountered during export generation.",
    )

    class Meta:
        model = PublicationExportJob
        fields = [
            'id',
            'status',
            'complete',
            'warnings',
            'error_message',
            'file_name',
            'file_size',
            'checksum_sha256',
            'article_count',
            'asset_count',
            'created_at',
            'updated_at',
            'started_at',
            'completed_at',
            'expires_at',
            'download_url',
            'is_expired',
        ]
        read_only_fields = fields

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_download_url(self, obj: PublicationExportJob) -> str | None:
        if obj.status == ExportStatus.READY and not obj.is_expired:
            return f"/api/exports/publications/{obj.id}/download/"
        return None


class PublicationExportErrorSerializer(serializers.Serializer):
    detail = serializers.CharField()
