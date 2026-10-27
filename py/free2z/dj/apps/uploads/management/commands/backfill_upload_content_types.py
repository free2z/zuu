"""
Repair the stored ``Content-Type`` of objects uploaded before the explicit MIME
registry existed.

``mimetypes.guess_type`` runs at **upload** time — django-storages stamps the
GCS blob's ``content_type`` once, in ``_save``
(``storages/backends/gcloud.py:209``), and never revisits it. Registering
``.webp`` in ``dj/util/mimetypes_registry.py`` therefore fixes every *new*
upload and does nothing at all for the 288 WebP objects (plus every generated
``Webp`` thumbnail and ``ImageVariant`` rendition, which are all ``.webp``)
already sitting in the bucket with ``application/octet-stream``. This command
is that half.

What it does and does not touch
-------------------------------
It rewrites **blob metadata only** — one ``PATCH`` per object setting
``contentType``. The bytes are never read, never re-uploaded, never hashed;
the object's generation does not change, only its metageneration.

Safety properties
-----------------
1. The target type always comes from ``MIME_TYPE_REGISTRY``, which
   ``check_registry_is_passive()`` proves at import time contains **no active
   document type**. There is no code path by which this command can turn an
   object into ``text/html`` or ``image/svg+xml`` — it cannot manufacture the
    stored-XSS vulnerability. ``_assert_safe_target`` re-checks per write
   so the property survives a careless edit to the registry.
2. An extension that is not in the registry is skipped entirely. ``.svg``,
   ``.html``, ``.php`` and friends are never read, never planned, never
   written.
3. Report-only by default. ``--apply`` is required for any write, exactly like
   ``audit_active_uploads``, **and** ``--apply`` additionally requires
   ``--bucket <name>`` matching ``settings.GS_BUCKET_NAME``: that setting is a
   hardcoded, un-namespaced constant, so every shell with settings loaded --
   a laptop included -- otherwise writes straight to production.
4. Objects the DB knows about but the bucket does not are reported, never
   created -- and their presence keeps ``complete`` false.
5. Repeated lookup failures abort (``--max-errors``, default 10). Bad
   credentials fail on every object; one readable error beats 22,900.

Usage
-----
::

    # report only, no network at all: what the DB says should change
    manage.py backfill_upload_content_types

    # same, but ask GCS for each object's current type (read-only, one API
    # call per candidate row — scope it with --extensions)
    manage.py backfill_upload_content_types --check-remote --extensions webp

    # do it -- --bucket must name the bucket you mean, because
    # GS_BUCKET_NAME is hardcoded and un-namespaced, so a laptop shell
    # points at production by default
    manage.py backfill_upload_content_types \\
        --apply --extensions webp --bucket free2z-uploads

    # machine readable (stdout is pure JSON; all commentary goes to stderr)
    manage.py backfill_upload_content_types --check-remote --json

Cloud CDN — the job is NOT done when this command finishes
----------------------------------------------------------
``/uploadz/public/`` now sends
``Cache-Control: public, max-age=300, s-maxage=3600, proxy-revalidate`` and
Cloud CDN is enabled on the backend. An edge copy carries the *old*
``Content-Type`` and its original freshness metadata; rolling out the new
origin headers does not rewrite a response already cached there. It is served
without ever consulting nginx, the auth subrequest or GCS. Rewriting blob
metadata does nothing to it. For urgent security remediation, after
``--apply``, invalidate both upload objects and generated article cards that
may contain them::

    gcloud compute url-maps invalidate-cdn-cache <url-map> \\
        --path '/uploadz/*' --async
    gcloud compute url-maps invalidate-cdn-cache <url-map> \\
        --path '/og/zpage/*' --async

The reminder is printed whenever anything changes, and surfaces in ``--json``
as ``cdn_invalidation_required`` / ``cdn_invalidation_command``.

A CDN purge is still not the whole story: browser and social-platform copies
cannot be purged by Free2Z. A client may keep an old response until it expires;
a changed image URL can prompt a platform to fetch again but does not erase its
old copy.
"""
import json
import os

from django.apps import apps
from django.conf import settings
from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand, CommandError
from django.db import models

from dj.apps.uploads.models import GenericFile
from dj.util.mimetypes_registry import (
    ACTIVE_CONTENT_TYPES,
    MIME_TYPE_REGISTRY,
    content_type_for,
)


CDN_INVALIDATION_COMMAND = (
    "gcloud compute url-maps invalidate-cdn-cache <url-map> "
    "--path '/uploadz/*' --async\n"
    "gcloud compute url-maps invalidate-cdn-cache <url-map> "
    "--path '/og/zpage/*' --async"
)

CDN_REMINDER = (
    '\nNOT DONE YET: /uploadz/public/ now sends max-age=300, s-maxage=3600,\n'
    'proxy-revalidate, but Cloud CDN is on. An origin-header rollout does not\n'
    'rewrite an edge copy that still carries the OLD Content-Type;\n'
    'invalidate uploads and generated article cards:\n'
    f'    {CDN_INVALIDATION_COMMAND}\n'
    '\nAND NOTE: browser and social-platform copies cannot be purged by this\n'
    'invalidation. A client may keep an old response until it expires; a new\n'
    'URL can prompt a platform to fetch again but does not erase the old copy.\n'
)

GENERICFILE_LABEL = 'uploads.genericfile.file'


def discover_sources():
    """
    Every ``FileField``/``ImageField`` in the project whose objects land in
    the default (GCS) storage, as ``{label: (model, field_name)}`` with label
    ``<app>.<model>.<field>``.

    Discovered rather than hardcoded, deliberately. A hand-written list is
    wrong the moment someone adds a model, and the first version of this
    command was already wrong: it listed the three ``uploads`` models and
    silently skipped ``kyc`` (``UserProfile.id_front/id_back/live_photo/
    additional_document`` plus ``W9``/``W8BEN``/``W8BENE``.file), whose
    objects sit in the same bucket, get their Content-Type from the same
    ``guess_type`` call, and are exactly the identity documents a staff
    member needs to be able to *view* rather than download.

    Fields with an explicitly different storage are excluded: their objects
    are not in this bucket and their metadata is not ours to rewrite.
    """
    sources = {}
    for model in apps.get_models():
        for field in model._meta.get_fields():
            if not isinstance(field, models.FileField):
                continue
            # FileField.storage is default_storage (the LazyObject) unless the
            # field was declared with an explicit storage=.
            if getattr(field, 'storage', None) is not default_storage:
                continue
            label = f'{model._meta.label_lower}.{field.name}'
            sources[label] = (model, field.name)
    return sources


def _assert_safe_target(content_type: str) -> None:
    """
    Last line of defence before a write: never, under any circumstance, stamp
    an object with a type a browser executes in the free2z.cash origin.
    """
    if content_type not in MIME_TYPE_REGISTRY.values():
        raise CommandError(
            f'refusing to write {content_type!r}: not a value in '
            'MIME_TYPE_REGISTRY'
        )
    if content_type.split(';')[0].strip().lower() in ACTIVE_CONTENT_TYPES:
        raise CommandError(
            f'refusing to write the ACTIVE document type {content_type!r} '
            '(#962)'
        )


class Command(BaseCommand):
    help = (
        'Report (and with --apply, repair) stored uploads whose GCS '
        'Content-Type disagrees with the explicit MIME registry -- e.g. the '
        'WebP objects served as application/octet-stream (#971).'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--apply', action='store_true',
            help='Actually rewrite blob metadata. Without it, dry run. '
                 'Implies --check-remote.',
        )
        parser.add_argument(
            '--check-remote', action='store_true', dest='check_remote',
            help='Read each candidate object\'s current Content-Type from '
                 'GCS (read-only, one API call per candidate). Without it '
                 'the report is derived from the database alone and costs '
                 'nothing.',
        )
        parser.add_argument(
            '--extensions', default='',
            help='Comma-separated extensions to consider, with or without '
                 'the dot (e.g. "webp,m4a"). Default: every extension in the '
                 'registry. Use this to keep --check-remote cheap.',
        )
        parser.add_argument(
            '--fields', default='all', dest='fields',
            help='Comma-separated <app>.<model>.<field> labels to scan '
                 '(default: all). The set is DISCOVERED from the models -- '
                 'every FileField/ImageField on the default storage -- not '
                 'hardcoded. Run with --list-fields to see it.',
        )
        parser.add_argument(
            '--list-fields', action='store_true', dest='list_fields',
            help='Print the discovered field labels and exit.',
        )
        parser.add_argument(
            '--limit', type=int, default=0,
            help='Plan at most N candidate objects (0 = no limit). Counts of '
                 'scanned rows stay complete. A truncated run can never '
                 'report complete=true: it repairs only a prefix of the '
                 'corpus, and re-running re-plans that same prefix.',
        )
        parser.add_argument(
            '--list-limit', type=int, default=50,
            help='Max rows to print per section in text mode (0 = no limit).',
        )
        parser.add_argument(
            '--bucket', default='',
            help='Required with --apply: the name of the bucket you believe '
                 'you are about to modify. It must equal settings.'
                 'GS_BUCKET_NAME. GS_BUCKET_NAME is hardcoded and NOT '
                 'namespaced, so a developer shell points at the production '
                 'bucket by default -- naming it out loud is the guard.',
        )
        parser.add_argument(
            '--max-errors', type=int, default=10, dest='max_errors',
            help='Abort once this many object lookups have failed (0 = never '
                 'abort). Bad credentials or a wrong bucket fail on every '
                 'object; stopping early turns that into one readable error '
                 'instead of 22,900.',
        )
        parser.add_argument(
            '--json', action='store_true', dest='as_json',
            help='Emit a machine-readable report on stdout. stdout is then '
                 'pure JSON -- every human/operational message goes to '
                 'stderr.',
        )

    # -- plumbing ---------------------------------------------------------
    def _note(self, message, style=None):
        """Operational commentary. ALWAYS stderr, so --json stdout stays pure."""
        self.stderr.write(style(message) if style else message)

    # -- main -------------------------------------------------------------
    def handle(self, *args, **options):
        sources = discover_sources()

        if options['list_fields']:
            payload = sorted(sources)
            if options['as_json']:
                self.stdout.write(json.dumps({'fields': payload}, indent=2))
            else:
                for label in payload:
                    self.stdout.write(label)
            return

        apply_changes = options['apply']
        check_remote = options['check_remote'] or apply_changes

        if apply_changes:
            self._confirm_bucket(options['bucket'])

        extensions = self._parse_extensions(options['extensions'])
        fields = self._parse_fields(options['fields'], sources)
        if options['limit'] < 0:
            raise CommandError('--limit must be >= 0 (0 means no limit).')
        limit = options['limit'] or None

        plan, scanned, unregistered, truncated = self._plan(
            sources, fields, extensions, limit)

        result = {
            'applied': apply_changes,
            'checked_remote': check_remote,
            'extensions': sorted(extensions),
            'fields': sorted(fields),
            'scanned_rows': scanned,
            'skipped_unregistered_extension': unregistered,
            'candidates': len(plan),
            # True when --limit cut the plan short. `complete` can never be
            # true in that case: a truncated run repairs a prefix of the
            # corpus and re-running it re-plans the same prefix (now already
            # correct) and still never reaches the tail.
            'truncated_by_limit': truncated,
            'already_correct': 0,
            'needs_update': [],
            'missing_objects': [],
            'errors': [],
            'updated': 0,
            # None until --apply runs; then True only if every planned object
            # was rewritten with no errors. Automation should gate on this.
            'complete': None,
            'cdn_invalidation_required': False,
            'cdn_invalidation_command': CDN_INVALIDATION_COMMAND,
        }

        if not check_remote:
            result['needs_update'] = plan
            result['note'] = (
                'Database-only projection: "needs_update" lists every stored '
                'object whose extension is in the registry, without asking '
                'GCS what it currently serves. Re-run with --check-remote '
                'for the real delta.'
            )
            self._note(
                f'DRY RUN (database only, GCS not contacted): '
                f'{len(plan)} object(s) have a registered extension. '
                f'Add --check-remote to see which of them actually disagree, '
                f'then --apply.',
                self.style.WARNING,
            )
            self._emit(result, options)
            return

        bucket = self._get_bucket()
        max_errors = options['max_errors'] or None
        for row in plan:
            try:
                blob = bucket.get_blob(row['name'])
            except Exception as exc:  # network/permission, per object
                result['errors'].append(
                    {**row, 'error': f'{type(exc).__name__}: {exc}'})
                self._note(
                    f'  lookup failed {row["model"]}#{row["id"]} '
                    f'{row["name"]!r}: {type(exc).__name__}: {exc}',
                    self.style.ERROR,
                )
                if max_errors and len(result['errors']) >= max_errors:
                    # Emit the report FIRST. `--json` promises a structured
                    # document on stdout; an operator debugging expired
                    # credentials at 3am needs the error list, not an empty
                    # pipe. Then fail non-zero.
                    result['complete'] = False
                    self._emit(result, options)
                    raise CommandError(
                        f'aborting after {len(result["errors"])} failed '
                        'object lookups -- this is almost certainly bad '
                        'credentials or the wrong bucket, not bad data. '
                        'Nothing was modified. Raise --max-errors if you '
                        'really want to push through.'
                    )
                continue
            if blob is None:
                # The DB row and the bucket disagree. Never create anything.
                result['missing_objects'].append(row)
                continue
            current = blob.content_type
            if current == row['target_content_type']:
                result['already_correct'] += 1
                continue
            result['needs_update'].append({**row, 'current_content_type': current})

        if apply_changes:
            wanted = len(result['needs_update'])
            result['updated'] = self._apply(
                bucket, result['needs_update'], result['errors'], max_errors)
            result['cdn_invalidation_required'] = bool(result['updated'])
            if result['updated']:
                self._note(CDN_REMINDER, self.style.WARNING)
            # `complete` also requires an empty missing_objects list. Without
            # that, a run where EVERY candidate object is absent from the
            # bucket produces wanted == 0, updated == 0 and would report
            # `complete: true` -- telling automation the corpus is remediated
            # when in fact the DB and the bucket disagree about all of it.
            result['complete'] = (
                result['updated'] == wanted
                and not result['errors']
                and not result['missing_objects']
                and not result['truncated_by_limit']
            )
            if not result['complete']:
                # Do NOT exit 0 on a partial backfill. The classic failure is
                # credentials that can read (get_blob) but not write
                # (storage.objects.update): every preflight succeeds, every
                # PATCH 403s, and a silent success would tell the operator --
                # and any automation -- that remediation is done when not one
                # object changed. Emit the report first so the evidence
                # survives, then fail.
                self._emit(result, options)
                raise CommandError(
                    f'INCOMPLETE: {result["updated"]} of {wanted} object(s) '
                    f'rewritten, {len(result["errors"])} error(s), '
                    f'{len(result["missing_objects"])} object(s) in the DB '
                    'but not in the bucket'
                    + (', plan TRUNCATED by --limit'
                       if result['truncated_by_limit'] else '')
                    + '. The backfill did NOT finish -- do not treat this as '
                    'remediated. A common cause is credentials with '
                    'storage.objects.get but not storage.objects.update.'
                )
        elif result['needs_update']:
            self._note(
                f'DRY RUN: would rewrite the Content-Type of '
                f'{len(result["needs_update"])} object(s). Re-run with '
                f'--apply to do it.',
                self.style.WARNING,
            )

        self._emit(result, options)

    # -- steps ------------------------------------------------------------
    def _confirm_bucket(self, named):
        """
        ``GS_BUCKET_NAME`` is a hardcoded, un-namespaced constant, so *any*
        shell with settings loaded -- a laptop included -- writes to the
        production bucket. Make the operator name it.
        """
        configured = getattr(settings, 'GS_BUCKET_NAME', None)
        if not named:
            raise CommandError(
                '--apply also requires --bucket <name>. The configured '
                f'bucket is {configured!r}, and GS_BUCKET_NAME is not '
                'namespaced per environment, so this would write to '
                'production from anywhere. Pass --bucket '
                f'{configured} if that is what you mean.'
            )
        if named != configured:
            raise CommandError(
                f'--bucket {named!r} does not match the configured bucket '
                f'{configured!r}. Refusing to run: your settings are not '
                'pointing where you think they are.'
            )

    def _parse_extensions(self, raw):
        if not raw.strip():
            return set(MIME_TYPE_REGISTRY)
        wanted = set()
        for chunk in raw.split(','):
            chunk = chunk.strip().lower()
            if not chunk:
                continue
            ext = chunk if chunk.startswith('.') else '.' + chunk
            if ext not in MIME_TYPE_REGISTRY:
                raise CommandError(
                    f'{ext!r} is not in MIME_TYPE_REGISTRY, so there is no '
                    'target type for it. Add it to '
                    'dj/util/mimetypes_registry.py first (and only if it is '
                    'a passive media type).'
                )
            wanted.add(ext)
        if not wanted:
            raise CommandError('--extensions was given but parsed to nothing.')
        return wanted

    def _parse_fields(self, raw, sources):
        if raw.strip().lower() in ('', 'all'):
            return set(sources)
        wanted = {c.strip().lower() for c in raw.split(',') if c.strip()}
        unknown = wanted - set(sources)
        if unknown:
            raise CommandError(
                f'unknown --fields value(s): {sorted(unknown)}; '
                f'choose from {sorted(sources)} (or run --list-fields)'
            )
        return wanted

    def _plan(self, sources, fields, extensions, limit):
        """
        Pure, storage-free: which stored objects have a registered extension,
        and what type does the registry say they should be served as.
        """
        plan = []
        scanned = 0
        unregistered = 0
        truncated = False
        for label in sorted(fields):
            model, field_name = sources[label]
            rows = (
                model.objects.exclude(**{field_name: ''})
                .exclude(**{f'{field_name}__isnull': True})
                .values_list('pk', field_name)
                .order_by('pk')
            )
            for pk, name in rows.iterator():
                scanned += 1
                target = content_type_for(name or '')
                if target is None:
                    unregistered += 1
                    continue
                if os.path.splitext(name)[1].lower() not in extensions:
                    continue
                if limit is not None and len(plan) >= limit:
                    truncated = True
                    continue
                plan.append({
                    'model': label,
                    'id': pk,
                    'name': name,
                    'target_content_type': target,
                })
        if GENERICFILE_LABEL in fields:
            self._annotate_db_mime_types(plan)
        return plan, scanned, unregistered, truncated

    def _annotate_db_mime_types(self, plan):
        """
        Surface rows whose GenericFile.mime_type column disagrees with what we
        are about to serve. Informational: the column is not what the browser
        sees, but a disagreement means one of the two is a lie and an operator
        should know which rows they are.
        """
        ids = [r['id'] for r in plan if r['model'] == GENERICFILE_LABEL]
        if not ids:
            return
        stored = dict(
            GenericFile.objects.filter(id__in=ids)
            .values_list('id', 'mime_type')
        )
        for row in plan:
            if row['model'] != GENERICFILE_LABEL:
                continue
            db_mime = stored.get(row['id'])
            row['db_mime_type'] = db_mime
            row['db_mime_type_disagrees'] = bool(
                db_mime and db_mime != row['target_content_type']
            )

    def _get_bucket(self):
        storage = default_storage
        bucket = getattr(storage, 'bucket', None)
        if bucket is None:
            raise CommandError(
                'the default storage backend is '
                f'{type(storage).__module__}.{type(storage).__name__}, which '
                'has no GCS bucket. Blob Content-Type only exists on GCS; '
                'run this against an environment configured with '
                'storages.backends.gcloud.GoogleCloudStorage, or drop '
                '--check-remote/--apply for the database-only projection.'
            )
        return bucket

    def _apply(self, bucket, rows, errors, max_errors):
        """
        Rewrite blob metadata. Every failure is recorded in ``errors`` (which
        is the JSON report's ``errors`` list, so nothing is swallowed) and
        counts toward ``--max-errors``: a permission or connectivity problem
        fails on *every* object, and grinding through 22,900 of them before
        reporting zero successes helps nobody.
        """
        updated = 0
        for row in rows:
            target = row['target_content_type']
            _assert_safe_target(target)
            try:
                blob = bucket.get_blob(row['name'])
                if blob is None:
                    errors.append({**row, 'error': 'vanished between plan '
                                                   'and apply'})
                    self._note(
                        f'  vanished between plan and apply: {row["name"]!r}',
                        self.style.WARNING,
                    )
                else:
                    # Metadata-only PATCH. The bytes are not read or
                    # rewritten; the object's generation is unchanged.
                    blob.content_type = target
                    blob.patch()
                    updated += 1
                    continue
            except Exception as exc:
                errors.append(
                    {**row, 'error': f'{type(exc).__name__}: {exc}'})
                self._note(
                    f'  failed {row["model"]}#{row["id"]} {row["name"]!r}: '
                    f'{type(exc).__name__}: {exc}',
                    self.style.ERROR,
                )
            if max_errors and len(errors) >= max_errors:
                self._note(
                    f'Stopping after {len(errors)} error(s) '
                    f'({updated} object(s) rewritten so far). '
                    'Raise --max-errors to push through.',
                    self.style.ERROR,
                )
                break
        self._note(
            f'Rewrote the Content-Type of {updated} object(s).',
            self.style.SUCCESS if updated else self.style.WARNING,
        )
        return updated

    # -- output -----------------------------------------------------------
    def _emit(self, result, options):
        if options['as_json']:
            # stdout is pure JSON. Nothing else may be written here.
            self.stdout.write(json.dumps(result, indent=2, default=str))
            return
        self._report(result, options)

    def _report(self, result, options):
        limit = options['list_limit'] or None
        write = self.stdout.write

        write(
            f'Scanned {result["scanned_rows"]} stored object row(s) across '
            f'{len(result["fields"])} FileField(s) on the default storage.'
        )
        write(
            f'  {result["skipped_unregistered_extension"]} had an extension '
            'that is not in the registry (left alone on purpose).'
        )
        write(f'  {result["candidates"]} candidate(s) after filtering.')
        if result['truncated_by_limit']:
            write(self.style.WARNING(
                '  TRUNCATED by --limit: this is a partial view of the '
                'corpus and can never be a complete backfill.'
            ))
        write('')

        if not result['checked_remote']:
            write(self.style.WARNING(
                'Database-only projection -- GCS was not contacted, so this '
                'lists every candidate rather than the real delta. Re-run '
                'with --check-remote (add --extensions webp to keep it '
                'cheap).'
            ))
            write('')

        write(f'Already correct: {result["already_correct"]}')
        write(self.style.WARNING(
            f'Would change: {len(result["needs_update"])}'
        ))
        for row in self._limited(result['needs_update'], limit):
            current = row.get('current_content_type', '<not checked>')
            write(
                f'  {row["model"]}#{row["id"]} {row["name"]!r}\n'
                f'      {current!r} -> {row["target_content_type"]!r}'
            )
            if row.get('db_mime_type_disagrees'):
                write(
                    f'      note: DB mime_type column says '
                    f'{row["db_mime_type"]!r}'
                )
        self._overflow(write, result['needs_update'], limit)

        if result['missing_objects']:
            write('')
            write(self.style.ERROR(
                f'In the database but NOT in the bucket: '
                f'{len(result["missing_objects"])}'
            ))
            for row in self._limited(result['missing_objects'], limit):
                write(f'  {row["model"]}#{row["id"]} {row["name"]!r}')
            self._overflow(write, result['missing_objects'], limit)

        if result['errors']:
            write('')
            write(self.style.ERROR(f'Errors: {len(result["errors"])}'))

        write('')
        if result['applied']:
            if result['complete']:
                write(self.style.SUCCESS(
                    f'Applied. {result["updated"]} object(s) rewritten.'
                ))
            else:
                write(self.style.ERROR(
                    f'INCOMPLETE. {result["updated"]} object(s) rewritten, '
                    f'{len(result["errors"])} error(s). This backfill did '
                    'NOT finish -- re-run it.'
                ))
            if result['cdn_invalidation_required']:
                write(self.style.WARNING(CDN_REMINDER))
        elif result['needs_update']:
            write(self.style.WARNING(
                'Report only -- nothing was modified. Re-run with --apply.'
            ))
        else:
            write(self.style.SUCCESS('Nothing to do.'))

    @staticmethod
    def _limited(rows, limit):
        return rows[:limit] if limit else rows

    @staticmethod
    def _overflow(write, rows, limit):
        if limit and len(rows) > limit:
            write(f'  ... {len(rows) - limit} more (raise --list-limit)')
