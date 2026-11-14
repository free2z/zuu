"""Verify the RealtimeKit control-plane credential with one read-only call.

    python manage.py rtk_check_credentials            # the configured mode
    python manage.py rtk_check_credentials --mode v4  # probe v4 explicitly

Performs exactly one ``GET meetings?page_no=1&per_page=1`` (list meetings) --
no meeting, participant, recording or preset is created or changed -- and
prints one JSON line with the mode used and the provider's HTTP status. It
prints no credential, header, URL or provider body. Exit status 0 when the
provider accepted the credential, 1 otherwise, so a detached Kubernetes Job
reports the verdict in its own completion state.

``--mode`` lets an operator prove a newly added v4 token while the running
pods are still on v2 (``RTK_API_MODE=auto`` with the v4 keys absent), or
prove the legacy key still works after v4 keys were added.
"""
import json
import sys

from django.core.management.base import BaseCommand

from dj.apps.dyte.client import (
    CONFIGURED_MODES, DyteClient, ProviderError, mode_report,
)


class Command(BaseCommand):
    help = (
        "One read-only RealtimeKit list-meetings call; prints the auth mode "
        "and HTTP status (never a secret). Exit 1 unless the provider "
        "accepted the credential."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--mode', choices=CONFIGURED_MODES, default=None,
            help="Credential mode to probe (default: RTK_API_MODE).",
        )

    def handle(self, *args, mode=None, **options):
        client = DyteClient(mode=mode)
        report = {
            'event': 'rtk_credentials_check',
            **mode_report(),
            'requested_mode': mode or 'configured',
            'auth_mode': client.auth_mode,
            'operation': 'list_meetings',
        }
        report['credentials_present'] = report[
            f'{client.auth_mode}_credentials_present']
        try:
            response = client.list_meetings(per_page=1)
        except ProviderError as exc:
            report.update(ok=False, status=exc.status or 0,
                          error=type(exc).__name__)
            if exc.provider_code is not None:
                report['provider_code'] = exc.provider_code
        else:
            report.update(ok=True, status=response.status_code)
        self.stdout.write(json.dumps(report, separators=(',', ':')))
        if not report['ok']:
            sys.exit(1)
