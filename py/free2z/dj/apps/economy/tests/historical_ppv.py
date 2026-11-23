"""Create pre-cutover cash admissions in an isolated owner-controlled test DB.

Only fixture construction suspends the prospective INSERT fence. Historical
settlement runs with every installed guard enabled, including credit overlap.
No runtime writer imports this module.
"""
from contextlib import contextmanager
from unittest.mock import patch

from django.db import connection, transaction

from dj.apps.economy import contracts, products


@contextmanager
def before_credit_cutover():
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
            cursor.execute("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='economy_new_ppv_credit_only')")
            installed = cursor.fetchone()[0]
            if installed:
                cursor.execute('ALTER TABLE economy_serviceadmission DISABLE TRIGGER economy_new_ppv_credit_only')
        try:
            with patch.object(contracts, 'PROSPECTIVE_COMPENSATION_SERVICES', ('sdk_application','livestream_ppv')):
                with transaction.atomic():
                    yield
        finally:
            if installed:
                with connection.cursor() as cursor:
                    cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
                    cursor.execute('ALTER TABLE economy_serviceadmission ENABLE TRIGGER economy_new_ppv_credit_only')
                    cursor.execute('SET CONSTRAINTS ALL DEFERRED')


def prepare_historical_ppv_admission(**kwargs):
    with before_credit_cutover():
        return products.prepare_livestream_admission(**kwargs)
