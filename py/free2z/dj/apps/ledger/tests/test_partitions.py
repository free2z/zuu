import pytest
from django.db import connection

from dj.apps.ledger.partitions import expected_partitions, maintain_partitions, partition_drift

pytestmark = pytest.mark.django_db


def test_maintenance_repairs_missing_future_partitions_and_is_idempotent():
    expected = list(expected_partitions())
    children = [expected[3][1], expected[7][1]]
    with connection.cursor() as cursor:
        for child in children:
            cursor.execute(f'DROP TABLE {child}')
    assert {item['table'] for item in partition_drift()} == set(children)
    assert maintain_partitions() == children
    assert partition_drift() == []
    assert maintain_partitions() == []


def test_existing_wrong_bounds_are_not_silently_accepted():
    child = list(expected_partitions())[-1][1]
    with connection.cursor() as cursor:
        cursor.execute(f'DROP TABLE {child}')
        cursor.execute(f'CREATE TABLE {child}(id bigint)')
    with pytest.raises(RuntimeError, match='unexpected parent or bounds'):
        maintain_partitions()
    assert any(item['table'] == child for item in partition_drift())
