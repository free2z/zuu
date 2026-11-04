""": every upload runs `_has_live_file_reference`, one `file = <key>`
lookup per upload-app FileField -- and the nginx auth subrequest resolves a
served name through the same columns. Each must be answerable from an index,
not a sequential scan of the table.

The KYC FileFields are scanned too but deliberately left unindexed: those
tables hold one row per account that opened KYC (a seq scan of 5,000 rows
measured ~1 ms locally), and indexing them is a second app's migration for
no measurable gain.
"""
import pytest
from django.db import connection

from dj.apps.uploads.models import GenericFile, ImageVariant, Webp


@pytest.mark.django_db
@pytest.mark.parametrize("model", [GenericFile, ImageVariant, Webp])
def test_the_file_column_is_the_leading_column_of_a_valid_index(model):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT count(*)
              FROM pg_index i
              JOIN pg_class t ON t.oid = i.indrelid
              JOIN pg_attribute a
                ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
             WHERE t.relname = %s
               AND a.attname = 'file'
               AND i.indisvalid
            """,
            [model._meta.db_table],
        )
        (count,) = cursor.fetchone()
    assert count >= 1, f"{model._meta.db_table}.file has no usable index"
