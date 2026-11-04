"""
Find (and optionally neutralize) uploads that a browser would treat as an
**active document** when served from https://free2z.cash —.

The upload allowlist (`dj.apps.uploads.validation`) stops new ones. It does
nothing about what is already in the bucket, and every one of those rows is a
live stored-XSS payload waiting to be linked. This command is the remediation
half.

What counts as "active" is decided by the *served* Content-Type, which
django-storages derives from the stored file name
(`mimetypes.guess_type(name)`) and nothing else. So the actionable signal is
the **name**, on two counts:

  * the stored name's extension is in `validation.ACTIVE_EXTENSIONS`
    (.svg,.html,.xhtml,.xml,.js,...),
  * `mimetypes.guess_type(stored name)` resolves to an active type — this is
    literally the header nginx will send.

The `mime_type` column is reported separately and **never acted on**. Under
the old code that column was copied straight from client-supplied multipart
metadata, so a genuine PNG stored as `cat.png` could carry a recorded type of
`image/svg+xml` while being served, harmlessly, as `image/png`. Feeding that
to `--delete` would destroy benign user data.

Rows whose type is simply not on the allowlist get a third, lowest-severity
heading — not XSS, just data that could not be uploaded today.

Usage
-----
    # report only (the default — nothing is modified)
    manage.py audit_active_uploads

    # same, machine readable
    manage.py audit_active_uploads --json

    # RECOMMENDED. Rename the stored object (evil.svg -> evil.svg.bin) so the
    # origin serves application/octet-stream. Keeps the row, the bytes and
    # the access level; only the URL changes.
    manage.py audit_active_uploads --neutralize --apply

    # access=private only. INCOMPLETE: uploads_auth still returns OK
    # unconditionally for superusers (and the owner), so the payload still
    # executes for staff who open the private link while triaging. Public
    # namespace auth requires access=public, but old CDN entries still need
    # the manual invalidation described below.
    manage.py audit_active_uploads --quarantine --apply

    # destructive, opt-in twice; deletes the row AND the stored object
    manage.py audit_active_uploads --delete --apply --yes-i-really-mean-delete

`--apply` is required for anything that writes. Without it every mode is a
dry run, including `--delete`. The modes are mutually exclusive.

Cloud CDN — remediation is NOT complete without this
----------------------------------------------------
`/uploadz/public/` now sends
`Cache-Control: public, max-age=300, s-maxage=3600, proxy-revalidate` and the
LB has Cloud CDN on in `USE_ORIGIN_HEADERS` mode
(`k8s/free2z/backend-config.yaml`). A response already in the edge cache keeps
its original freshness metadata; rolling out this header does not rewrite it,
and the edge answers without consulting nginx, the auth subrequest, or GCS.
Quarantining or deleting the row does nothing to that cached response. For
urgent security remediation, after running with `--apply`, invalidate the
source upload and generated article-card derivatives that may contain it:

    gcloud compute url-maps invalidate-cdn-cache <url-map> \\
        --path '/uploadz/public/<owner>/<name>' --async
    gcloud compute url-maps invalidate-cdn-cache <url-map> \\
        --path '/og/zpage/*' --async

or invalidate all sources with `--path '/uploadz/*'`. The command prints this
reminder on **stderr** whenever it changes anything, and `--json` carries a
`cdn_invalidation_required` boolean for scripted callers. Under `--json`,
stdout is only ever the JSON document — every operational message goes to
stderr — so `... --json | jq` is safe in every mode.

Neither invalidation can purge copies already held by a browser or social
platform. A client may keep an old response until it expires; a changed image
URL can prompt a platform to fetch again but does not erase its old copy.
"""
import json
import mimetypes
import os

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from dj.apps.uploads.models import UPLOAD_STORAGE_ALIAS, GenericFile
from dj.apps.uploads.tasks import _has_live_file_reference
from dj.apps.uploads.validation import (
    ACTIVE_EXTENSIONS,
    ACTIVE_MIME_TYPES,
    ALLOWED_MIME_TYPES,
)


CDN_REMINDER = (
    '\nNOT DONE YET: /uploadz/public/ now sends max-age=300, s-maxage=3600,\n'
    'proxy-revalidate, but Cloud CDN is enabled (USE_ORIGIN_HEADERS). An\n'
    'origin-header rollout does not rewrite anything already in the edge\n'
    'cache; it is still served bypassing nginx, the auth subrequest and GCS.\n'
    'For urgent security remediation, invalidate sources and article-card\n'
    'derivatives now:\n'
    "    gcloud compute url-maps invalidate-cdn-cache <url-map> "
    "--path '/uploadz/*' --async\n"
    "    gcloud compute url-maps invalidate-cdn-cache <url-map> "
    "--path '/og/zpage/*' --async\n"
    '\nAND NOTE: browser and social-platform copies cannot be purged by this\n'
    'invalidation. A client may keep an old response until it expires; a new\n'
    'URL can prompt a platform to fetch again but does not erase the old copy.\n'
)


# Appended to a neutralized object's name. `mimetypes.guess_type` maps `.bin`
# to application/octet-stream, so a renamed object can never be served as an
# active document — while the original name, and the bytes, are preserved.
NEUTRALIZED_SUFFIX = '.bin'


def classify(name: str) -> list[str]:
    """
    Reasons the *stored name* would be served as an active document. Empty
    list means it would not.

    Only the name is consulted, and that is the point. The served
    Content-Type comes from `mimetypes.guess_type(stored name)` and nothing
    else — see the module docstring. The `mime_type` column was populated
    from attacker-controlled multipart metadata under the old code, so a
    genuine PNG stored as `cat.png` but *recorded* as `image/svg+xml` was
    always served `image/png` and is perfectly benign. Treating that column
    as evidence here would put benign files in front of `--delete`
    (adversarial review finding 3); it is reported separately instead, and
    never acted on.
    """
    reasons = []
    ext = os.path.splitext(name or '')[1].lower()
    if ext in ACTIVE_EXTENSIONS:
        reasons.append(f'active extension "{ext}"')
    served, _ = mimetypes.guess_type(name or '')
    if served in ACTIVE_MIME_TYPES:
        reasons.append(f'would be served as "{served}"')
    return reasons


def has_active_metadata(mime_type: str) -> bool:
    """
    The `mime_type` column claims an active type. Suspicious — worth an
    operator's eyes — but not by itself dangerous, because it has no bearing
    on what the origin actually sends.
    """
    return (mime_type or '').lower() in ACTIVE_MIME_TYPES


class Command(BaseCommand):
    help = (
        'Audit stored uploads for active-document types (SVG/HTML/XML/...) '
        'that predate the #962 upload allowlist.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--apply', action='store_true',
            help='Actually perform the selected action. Without it, dry run.',
        )
        parser.add_argument(
            '--neutralize', action='store_true',
            help='RECOMMENDED. Rename the stored object so it can never be '
                 f'served as an active document (appends '
                 f'"{NEUTRALIZED_SUFFIX}"). Keeps the row, the bytes and the '
                 'access level; only the URL changes.',
        )
        parser.add_argument(
            '--quarantine', action='store_true',
            help="Set access='private' on every active-document row. "
                 'INCOMPLETE on its own: superusers and the owner are still '
                 'served the file, and it still executes for them.',
        )
        parser.add_argument(
            '--delete', action='store_true',
            help='DESTRUCTIVE. Delete the rows and their stored objects. '
                 'Requires --apply and --yes-i-really-mean-delete.',
        )
        parser.add_argument(
            '--yes-i-really-mean-delete', action='store_true',
            dest='confirm_delete',
            help='Second confirmation required by --delete.',
        )
        parser.add_argument(
            '--limit', type=int, default=200,
            help='Max rows to list per section (0 = no limit). '
                 'Counts are always complete.',
        )
        parser.add_argument(
            '--sample-cap', type=int, default=1000, dest='sample_cap',
            help='Max rows RETAINED in memory for the two informational '
                 'sections (0 = unbounded). Counts are always exact, and the '
                 'actionable active-document set is never sampled.',
        )
        parser.add_argument(
            '--json', action='store_true', dest='as_json',
            help='Emit a machine-readable report instead of text.',
        )

    def handle(self, *args, **options):
        chosen = [
            flag for flag in ('neutralize', 'quarantine', 'delete')
            if options[flag]
        ]
        if len(chosen) > 1:
            raise CommandError(
                'Choose one of --neutralize / --quarantine / --delete, '
                f'not {len(chosen)}.'
            )
        if options['delete'] and not options['confirm_delete']:
            raise CommandError(
                '--delete also requires --yes-i-really-mean-delete.')

        rows = GenericFile.objects.all().values_list(
            'id', 'file', 'mime_type', 'access', 'owner__username',
        ).order_by('id')

        # `active` is the actionable set and is retained in full — it drives
        # --neutralize/--delete, and an operator needs every one of them. It
        # is also tiny by nature: active documents are rare.
        #
        # The two informational buckets are only ever printed, and
        # off-allowlist rows in particular could be a large fraction of the
        # table. Retain a bounded sample of each (counts stay exact) so a
        # report-only run cannot exhaust the container's memory before it has
        # told anyone what needs remediating.
        sample_cap = options['sample_cap'] or None

        active = []
        suspicious_metadata = []
        off_allowlist = []
        suspicious_count = 0
        off_allowlist_count = 0
        total = 0
        for pk, name, mime_type, access, username in rows.iterator():
            total += 1
            reasons = classify(name)
            record = {
                'id': pk,
                'name': name,
                'mime_type': mime_type,
                'access': access,
                'owner': username,
            }
            if reasons:
                active.append({**record, 'reasons': reasons})
            elif has_active_metadata(mime_type):
                # Name is benign, so the origin serves it as something inert.
                # Report it, never act on it.
                suspicious_count += 1
                if sample_cap is None or len(suspicious_metadata) < sample_cap:
                    suspicious_metadata.append(record)
            elif mime_type not in ALLOWED_MIME_TYPES:
                off_allowlist_count += 1
                if sample_cap is None or len(off_allowlist) < sample_cap:
                    off_allowlist.append(record)

        changed = 0
        if active and chosen:
            changed = self._act(active, options)
            if changed:
                # stderr, not stdout: under --json stdout must stay a single
                # parseable document, and the operator scripting this is the
                # one who most needs to see the CDN warning.
                self._note(CDN_REMINDER, self.style.WARNING)

        if options['as_json']:
            # stdout carries ONLY this document. Everything operational above
            # went to stderr, so `manage.py audit_active_uploads --json | jq`
            # works in every mode, including --quarantine/--delete.
            self.stdout.write(json.dumps({
                'total_rows': total,
                'active_document_rows': active,
                'active_document_count': len(active),
                # Name is benign; reported for eyes only, never acted on.
                # *_count is exact; *_rows may be a bounded sample of it
                # (see --sample-cap).
                'suspicious_metadata_rows': suspicious_metadata,
                'suspicious_metadata_count': suspicious_count,
                'off_allowlist_count': off_allowlist_count,
                'off_allowlist_rows': off_allowlist,
                'rows_sampled': (
                    suspicious_count > len(suspicious_metadata)
                    or off_allowlist_count > len(off_allowlist)
                ),
                'applied': bool(options['apply']),
                'changed': changed,
                # True whenever bytes stopped being reachable through the
                # origin but may still be in the edge cache. Scripted callers
                # should gate their invalidation step on this.
                'cdn_invalidation_required': bool(changed),
            }, indent=2, default=str))
            return

        self._report(
            total, active,
            (suspicious_metadata, suspicious_count),
            (off_allowlist, off_allowlist_count),
            changed, options,
        )

    # ------------------------------------------------------------------
    def _note(self, message, style=None):
        """
        Operational chatter. Always stderr — stdout belongs to the report,
        which may be JSON.
        """
        self.stderr.write(style(message) if style else message)

    def _act(self, active, options):
        ids = [row['id'] for row in active]
        if not options['apply']:
            verb = (
                'neutralize' if options['neutralize']
                else 'quarantine' if options['quarantine']
                else 'DELETE'
            )
            self._note(
                f'DRY RUN: would {verb} {len(ids)} row(s). '
                'Re-run with --apply to do it.',
                self.style.WARNING,
            )
            return 0

        if options['neutralize']:
            return self._neutralize(ids)

        if options['quarantine']:
            with transaction.atomic():
                changed = GenericFile.objects.filter(
                    id__in=ids).exclude(access='private').update(
                        access='private')
            self._note(
                f'Quarantined {changed} row(s) to access=private.',
                self.style.SUCCESS,
            )
            self._note(
                'INCOMPLETE: --quarantine closes anonymous access through '
                'the origin. uploads_auth still returns OK unconditionally '
                'for superusers and the owner, so the payload still executes '
                'for staff who open the private link. Public namespace auth '
                'now requires access=public, but old CDN entries still need '
                'manual invalidation. Use '
                '--neutralize (or --delete) to actually defuse it.',
                self.style.WARNING,
            )
            return changed

        # --delete: keep the one-row-at-a-time audit output, while the
        # pre_delete outbox signal handles the blob for both instance and
        # queryset/cascade deletion paths.
        deleted = 0
        for pk in ids:
            try:
                GenericFile.objects.get(pk=pk).delete()
                deleted += 1
            except GenericFile.DoesNotExist:
                continue
            except Exception as exc:  # storage can fail independently
                self._note(
                    f'  failed to delete id={pk}: '
                    f'{type(exc).__name__}: {exc}',
                    self.style.ERROR,
                )
        self._note(
            f'Deleted {deleted} row(s) and their stored objects.',
            self.style.ERROR,
        )
        return deleted

    def _neutralize(self, ids):
        """
        Rename each stored object so the origin can no longer serve it as an
        active document, keeping the row, the bytes and the access level.

        This is the remediation that actually works. `--quarantine` only
        closes the anonymous/public origin path — uploads_auth still waves
        superusers and the owner through unconditionally, so a quarantined SVG
        still executes for the admin who opens the private link while triaging
        (adversarial review finding 2). Existing public CDN entries also need
        manual invalidation. Deleting works too but destroys user data,
        sometimes for a file that is merely unwise rather than hostile.

        Renaming is decisive because the served Content-Type is derived from
        the stored name and nothing else: `evil.svg` -> `evil.svg.bin` is
        served `application/octet-stream`, which no browser executes. The old
        name is preserved inside the new one, so the change is legible and
        reversible by hand.

        Storage has no rename primitive, so this is copy-then-delete. It is
        done per row, and a row whose copy fails is left exactly as it was.
        """
        renamed = 0
        for pk in ids:
            try:
                gfile = GenericFile.objects.get(pk=pk)
            except GenericFile.DoesNotExist:
                continue

            old_name = gfile.file.name
            if old_name.endswith(NEUTRALIZED_SUFFIX):
                continue  # already done; the command is idempotent

            new_name = f'{old_name}{NEUTRALIZED_SUFFIX}'
            try:
                # Hand the open File to storage rather than reading it into a
                # bytes object: legacy objects may be multi-GiB and this runs
                # in a container with a hard memory limit. Both backends
                # stream a File — FileSystemStorage chunks it, and
                # django-storages' GCS backend passes it to
                # blob.upload_from_file(rewind=True). `read()` here would
                # OOMKill the pod on a large object, aborting remediation
                # before anything was defused.
                gfile.file.open('rb')
                try:
                    stored_as = gfile.file.storage.save(new_name, gfile.file)
                finally:
                    gfile.file.close()
            except Exception as exc:
                self._note(
                    f'  failed to neutralize id={pk} ({old_name}): '
                    f'{type(exc).__name__}: {exc}',
                    self.style.ERROR,
                )
                continue

            # Point the row at the copy first. If the delete below fails, the
            # worst case is an orphaned original — still bad, but the row no
            # longer advertises it, and a re-run is safe.
            GenericFile.objects.filter(pk=pk).update(file=stored_as)
            # A legacy row may still share old_name. Deleting it
            # here would leave that row pointing at nothing, and it could
            # then never be neutralized (its copy needs these bytes). Keep
            # the object; the sharing row's own pass copies and deletes it.
            if _has_live_file_reference(old_name, UPLOAD_STORAGE_ALIAS):
                self._note(
                    f'  id={pk}: renamed to {stored_as}; {old_name} is '
                    'still referenced by another row, so it is kept until '
                    'that row is neutralized too.',
                    self.style.WARNING,
                )
                renamed += 1
                continue
            try:
                gfile.file.storage.delete(old_name)
            except Exception as exc:
                self._note(
                    f'  id={pk}: renamed to {stored_as} but the original '
                    f'{old_name} could not be deleted: '
                    f'{type(exc).__name__}: {exc}. Delete it by hand — it is '
                    'still served.',
                    self.style.ERROR,
                )
            renamed += 1

        self._note(
            f'Neutralized {renamed} row(s): stored objects renamed to '
            f'"*{NEUTRALIZED_SUFFIX}", now served application/octet-stream.',
            self.style.SUCCESS,
        )
        return renamed

    def _report(self, total, active, suspicious, off_allowlist_pair,
                changed, options):
        suspicious_metadata, suspicious_count = suspicious
        off_allowlist, off_allowlist_count = off_allowlist_pair
        limit = options['limit'] or None
        write = self.stdout.write

        write(f'Scanned {total} GenericFile row(s).')
        write('')

        style = self.style.ERROR if active else self.style.SUCCESS
        write(style(
            f'ACTIVE DOCUMENTS (stored XSS risk): {len(active)}'))
        for row in active[:limit] if limit else active:
            write(
                f'  id={row["id"]} owner={row["owner"]} '
                f'access={row["access"]} mime={row["mime_type"]!r} '
                f'name={row["name"]!r}'
            )
            write(f'      -> {"; ".join(row["reasons"])}')
        if limit and len(active) > limit:
            write(f'  ... {len(active) - limit} more (raise --limit)')

        write('')
        write(
            f'SUSPICIOUS METADATA (name is benign, NOT acted on): '
            f'{suspicious_count}'
        )
        write(
            '  The mime_type column claims an active type, but the stored '
            'name does not,\n  so the origin serves these as something inert. '
            'Old uploads took that column\n  straight from client-supplied '
            'multipart metadata, so it proves nothing.'
        )
        for row in (suspicious_metadata[:limit] if limit
                    else suspicious_metadata):
            write(
                f'  id={row["id"]} owner={row["owner"]} '
                f'mime={row["mime_type"]!r} name={row["name"]!r}'
            )
        if suspicious_count > len(suspicious_metadata):
            write(
                f'  ... {suspicious_count - len(suspicious_metadata)} more '
                'not retained (raise --sample-cap)'
            )
        elif limit and len(suspicious_metadata) > limit:
            write(
                f'  ... {len(suspicious_metadata) - limit} more '
                '(raise --limit)'
            )

        write('')
        write(
            f'OFF-ALLOWLIST (not XSS, but would be rejected today): '
            f'{off_allowlist_count}'
        )
        for row in (off_allowlist[:limit] if limit else off_allowlist):
            write(
                f'  id={row["id"]} owner={row["owner"]} '
                f'mime={row["mime_type"]!r} name={row["name"]!r}'
            )
        if off_allowlist_count > len(off_allowlist):
            write(
                f'  ... {off_allowlist_count - len(off_allowlist)} more '
                'not retained (raise --sample-cap)'
            )
        elif limit and len(off_allowlist) > limit:
            write(f'  ... {len(off_allowlist) - limit} more (raise --limit)')

        write('')
        acting = (
            options['neutralize'] or options['quarantine'] or options['delete']
        )
        if not active:
            write(self.style.SUCCESS('Nothing to remediate.'))
        elif not acting:
            write(self.style.WARNING(
                'Report only. Recommended next step:\n'
                '    --neutralize --apply    rename the stored objects so '
                'they cannot be served\n'
                '                            as documents (keeps the row, '
                'the bytes and access)\n'
                'Alternatives:\n'
                '    --quarantine --apply    access=private only; superusers '
                'and the owner are\n'
                '                            still served the file and it '
                'still executes for them\n'
                '    --delete --apply --yes-i-really-mean-delete   '
                'destroys the data'
            ))
        elif changed:
            write(self.style.SUCCESS(f'{changed} row(s) changed.'))
