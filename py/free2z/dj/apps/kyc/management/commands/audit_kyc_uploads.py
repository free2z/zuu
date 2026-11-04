"""
Report KYC documents whose STORED NAME would make them an active document when
served from https://free2z.cash —.

Why a separate command from `audit_active_uploads`
--------------------------------------------------
That one scans `GenericFile` (the uploads app). KYC documents are different
models entirely — `UserProfile.id_front/.id_back/.additional_document/
.live_photo` and `W9/W8BEN/W8BENE.file` — so nothing scanned them. The
production audit that found "0 dangerous objects" was done by hand against the
GCS bucket; this makes it a command anyone can re-run, which is the difference
between a fact and a claim.

What it looks at
----------------
Only the stored file **name**, because that is the only input to the served
`Content-Type`: django-storages does `mimetypes.guess_type(name)` and nginx
proxies the bytes inline. Three buckets, worst first:

  1. **active** — the extension is in `uploads.validation.ACTIVE_EXTENSIONS`,
     or `guess_type()` resolves to an `ACTIVE_MIME_TYPE`. These are the
     stored-XSS payloads. The reader is a KYC reviewer, and
     `uploads_auth_private` authorizes any superuser, so these are aimed at an
     admin session.
  2. **off-allowlist** — an extension that could not be uploaded today.
     Not XSS; served `application/octet-stream` or some passive type.
  3. **wrong field type** — allowlisted, but not a type this field accepts
     under the current policy (a PDF in `id_front`, say). Informational.

Report only, on purpose
-----------------------
There is no `--neutralize` / `--delete`. The  audit found zero hits across
all 58 KYC-shaped objects, so a remediation mode would be untested code with
write access to identity documents — a worse risk than the one it addresses. If
this command ever reports something, write the remediation then, against a real
example. `audit_active_uploads --neutralize` is the pattern to copy.

Usage
-----
    manage.py audit_kyc_uploads
    manage.py audit_kyc_uploads --json

Exit status is 1 when anything lands in bucket 1, so it can be wired to an
alert; 0 otherwise.
"""
import json
import mimetypes
import os

from django.core.management.base import BaseCommand

from dj.apps.uploads.validation import (
    ACTIVE_EXTENSIONS,
    ACTIVE_MIME_TYPES,
    EXTENSION_TO_TYPE,
)

from dj.apps.kyc.models import UserProfile, W9, W8BEN, W8BENE
from dj.apps.kyc.validation import IDENTITY_FIELD_TYPES, TAX_FORM_TYPES


# (model, field name, allowed canonical types for that field)
SCAN_TARGETS = [
    (UserProfile, field, allowed)
    for field, allowed in IDENTITY_FIELD_TYPES.items()
] + [
    (W9, 'file', TAX_FORM_TYPES),
    (W8BEN, 'file', TAX_FORM_TYPES),
    (W8BENE, 'file', TAX_FORM_TYPES),
]


def _classify(name, allowed_types):
    """('active' | 'off_allowlist' | 'wrong_field' | None, served_type)."""
    served = mimetypes.guess_type(name)[0]
    ext = os.path.splitext(name)[1].lower()
    if ext in ACTIVE_EXTENSIONS or served in ACTIVE_MIME_TYPES:
        return 'active', served
    canonical = EXTENSION_TO_TYPE.get(ext)
    if canonical is None:
        return 'off_allowlist', served
    if canonical not in allowed_types:
        return 'wrong_field', served
    return None, served


class Command(BaseCommand):
    help = 'Report KYC documents stored under a dangerous or unexpected name (#969).'

    def add_arguments(self, parser):
        parser.add_argument('--json', action='store_true', dest='as_json')

    def handle(self, *args, **options):
        findings = {'active': [], 'off_allowlist': [], 'wrong_field': []}
        scanned = 0

        for model, field, allowed_types in SCAN_TARGETS:
            queryset = (
                model.objects
                .exclude(**{field: ''})
                .exclude(**{f'{field}__isnull': True})
                .values_list('pk', field)
            )
            for pk, name in queryset.iterator():
                if not name:
                    continue
                scanned += 1
                bucket, served = _classify(name, allowed_types)
                if bucket is None:
                    continue
                findings[bucket].append({
                    'model': model.__name__,
                    'field': field,
                    'pk': str(pk),
                    'name': name,
                    'served_content_type': served,
                })

        if options['as_json']:
            self.stdout.write(json.dumps(
                {'scanned': scanned, 'findings': findings}, indent=2))
        else:
            self.stdout.write(f'Scanned {scanned} stored KYC file names.')
            for bucket, label in (
                ('active', 'ACTIVE DOCUMENTS (stored XSS aimed at a reviewer)'),
                ('off_allowlist', 'Off-allowlist extension (not currently uploadable)'),
                ('wrong_field', 'Allowlisted, but not a type this field accepts'),
            ):
                rows = findings[bucket]
                self.stdout.write(f'\n{label}: {len(rows)}')
                for row in rows:
                    self.stdout.write(
                        f"  {row['model']}.{row['field']} pk={row['pk']} "
                        f"{row['name']} -> {row['served_content_type']}")

        if findings['active']:
            # Loud, and non-zero, so this can be a scheduled check.
            raise SystemExit(1)
