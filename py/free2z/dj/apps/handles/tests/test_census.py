"""``manage.py handle_census``: read-only by default, and what it counts."""

import json
from datetime import datetime, timedelta, timezone
from io import StringIO

import pytest
from django.core.management import call_command

from dj.apps.handles.models import MessagingHandle

pytestmark = pytest.mark.django_db

T0 = datetime(2022, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def population(creator_factory):
    def make(username, days, **extra):
        user = creator_factory(username=username, **extra)
        type(user).objects.filter(pk=user.pk).update(
            date_joined=T0 + timedelta(days=days)
        )
        return user

    people = {
        "Quinn": make("Quinn", 0, is_active=False),
        "quinn": make("quinn", 1, username_ci_legacy="quinn"),
        "rob": make("rob", 0),
        "has.dot": make("has.dot", 0),
        "ünicode": make("ünicode", 0),
        "long": make("l" * 31, 0),
        "admin": make("admin", 0),
    }
    # An eligible account created by a pre-migration pod: no row.
    late = make("late_one", 5)
    MessagingHandle.objects.filter(user=late).delete()
    people["late_one"] = late
    return people


def _run(*args):
    out = StringIO()
    call_command("handle_census", "--json", *args, stdout=out)
    return json.loads(out.getvalue())


def test_the_default_run_counts_and_writes_nothing(population):
    before = list(MessagingHandle.objects.values_list("handle", "user_id"))
    report = _run()
    assert list(MessagingHandle.objects.values_list("handle", "user_id")) == before

    assert report["accounts"] == {"total": 8, "active": 7}
    assert report["eligibility"]["eligible"]["total"] == 5
    assert report["eligibility"]["punctuation"]["total"] == 1
    assert report["eligibility"]["non-ascii"]["total"] == 1
    assert report["eligibility"]["too-long"]["total"] == 1
    assert report["eligible_but_reserved_word"] == 1

    groups = report["handle_collision_groups"]
    assert groups["groups"] == 1
    assert groups["accounts_left_without_the_name"] == 1
    assert groups["groups_whose_earliest_account_is_inactive"] == 1

    assert report["handles"]["eligible_accounts_without_a_handle"] == 3
    assert report["handles"]["username_ci_legacy"] == 1
    assert report["plan"]["reserved"] == 1  # late_one
    assert report["plan"]["collision_or_taken"] == 1  # quinn
    assert report["plan"]["reserved_word"] == 1  # admin
    # No usernames unless asked.
    assert "Quinn" not in json.dumps(report)


def test_the_default_run_is_a_read_only_transaction(population, mocker):
    """Even a bug that tried to write would be refused by PostgreSQL."""
    from django.db import InternalError, connection

    from dj.apps.handles.management.commands import handle_census

    def sabotage(self, **kwargs):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM handles_messaginghandle")

    mocker.patch.object(handle_census.Command, "_plan", sabotage)
    count = MessagingHandle.objects.count()
    with pytest.raises(InternalError, match="read-only transaction"):
        _run()
    assert MessagingHandle.objects.count() == count


def test_show_groups_lists_only_staff_visible_fields(population):
    report = _run("--show-groups")
    [group] = report["groups"]
    assert [(m["username"], m["keeps_name"], m["is_active"]) for m in group] == [
        ("Quinn", True, False),
        ("quinn", False, True),
    ]
    assert set(group[0]) == {"id", "username", "date_joined", "is_active", "keeps_name"}


def test_apply_reserves_the_stragglers_and_nothing_else(population):
    report = _run("--apply")
    assert report["applied"]["reserved"] == 1
    assert MessagingHandle.objects.get(user=population["late_one"]).handle == "late_one"
    assert not MessagingHandle.objects.filter(user=population["quinn"]).exists()
    assert not MessagingHandle.objects.filter(user=population["admin"]).exists()
    assert _run("--apply")["applied"]["reserved"] == 0
