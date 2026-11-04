"""0006_call_features: a content-free ``features`` object on claim metadata.

Real PostgreSQL. ``gateway_metadata_valid`` accepts an OPTIONAL ``features``
object on the request metadata with exactly eight typed members, keeps every
0004 rule, and the stored object is visible on the call record
(``record.request.features``) through both ``call_claim`` and ``call_read``.
"""
import json
import re

import pytest
from django.db import DatabaseError, connection, transaction

from . import test_gateway_calls
from .test_gateway_calls import COMPLETE, REQUEST, claim, read

holder = test_gateway_calls.holder
ledger_third_party = test_gateway_calls.ledger_third_party
third_party = test_gateway_calls.third_party

pytestmark = pytest.mark.django_db

FEATURES = {
    'response_format': 'json_schema', 'response_format_strict': True,
    'response_format_schema_name': 'activity_spec', 'response_format_schema_bytes': 1834,
    'tools': 0, 'max_output_tokens_strict': False, 'stream': True, 'fallback': 0,
}
ABSENT = {
    'response_format': None, 'response_format_strict': None,
    'response_format_schema_name': None, 'response_format_schema_bytes': 0,
    'tools': 3, 'max_output_tokens_strict': True, 'stream': False, 'fallback': 2,
}


def valid(meta, completion=False):
    with connection.cursor() as cursor:
        cursor.execute('SELECT ledger.gateway_metadata_valid(%s::jsonb,%s)',
                       [meta if isinstance(meta, str) else json.dumps(meta), completion])
        return cursor.fetchone()[0]


def with_features(**changes):
    return dict(REQUEST, features=dict(FEATURES, **changes))


def test_features_are_accepted_and_visible_on_the_call_record(holder, third_party):
    request = dict(REQUEST, features=FEATURES)
    first = claim(holder, third_party, request=request)
    assert first['status'] == 'claimed'
    assert first['record']['request']['features'] == FEATURES
    assert read(holder, third_party, first['call_id'])['record']['request']['features'] == FEATURES
    # Same body, same key: recovery returns the stored record, features included.
    replay = claim(holder, third_party, request=request)
    assert (replay['status'], replay['call_id']) == ('pending', first['call_id'])
    assert replay['record']['request']['features'] == FEATURES
    no_format = claim(holder, third_party, key='other-key', fingerprint='c'*64,
                      request=dict(REQUEST, features=ABSENT))
    assert no_format['status'] == 'claimed' and no_format['record']['request']['features'] == ABSENT


def test_existing_metadata_without_features_is_still_valid(holder, third_party):
    assert valid(REQUEST) is True
    assert valid(COMPLETE, completion=True) is True
    claimed = claim(holder, third_party)
    assert claimed['status'] == 'claimed' and 'features' not in claimed['record']['request']


@pytest.mark.parametrize('meta', [
    dict(REQUEST, features='json_schema'),                        # not an object
    dict(REQUEST, features=None),
    dict(REQUEST, features=[]),
    with_features(prompt='hello'),                                # unknown member
    {**REQUEST, 'features': {k: v for k, v in FEATURES.items() if k != 'stream'}},   # missing member
    with_features(response_format='text'),                        # not in the enum
    with_features(response_format=1),
    with_features(response_format_strict='true'),
    with_features(response_format_schema_name='has space'),
    with_features(response_format_schema_name=''),
    with_features(response_format_schema_name='a' * 65),
    with_features(response_format_schema_name={'name': 'x'}),
    with_features(response_format_schema_bytes=-1),
    with_features(response_format_schema_bytes=1.5),
    with_features(response_format_schema_bytes=2147483648),
    with_features(response_format_schema_bytes='12'),
    with_features(response_format_schema_bytes=None),
    with_features(tools=True),
    with_features(fallback=None),
    with_features(stream=None),
    with_features(max_output_tokens_strict=0),
])
def test_malformed_features_are_invalid(meta):
    assert valid(meta) is False


def test_integer_bounds_and_name_charset():
    assert valid(with_features(tools=2147483647, fallback=0, response_format_schema_bytes=0)) is True
    assert valid(with_features(response_format_schema_name='A-z_9' + 'x' * 59)) is True   # 64 chars
    assert valid(with_features(response_format='json_object', response_format_schema_name=None,
                               response_format_strict=None)) is True


def test_features_are_refused_on_a_completion_and_by_call_claim_when_malformed(holder, third_party):
    assert valid(dict(COMPLETE, features=FEATURES), completion=True) is False
    with pytest.raises(DatabaseError, match='invalid gateway call claim'), transaction.atomic():
        claim(holder, third_party, request=with_features(tools=-1))
    with pytest.raises(DatabaseError, match='invalid gateway call claim'), transaction.atomic():
        claim(holder, third_party, request=dict(REQUEST, features='json_schema'))


def test_negative_control_0004_body_refuses_features(holder, third_party):
    """The 0006 rewind is the 0004 body: ``features`` is an unknown key again,
    which is exactly why the gateway gates sending it until this ships."""
    from dj.apps.ledger.migrations._call_features import REVERSE_SQL
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(REVERSE_SQL)
        assert valid(dict(REQUEST, features=FEATURES)) is False
        assert valid(REQUEST) is True
        with pytest.raises(DatabaseError, match='invalid gateway call claim'), transaction.atomic():
            claim(holder, third_party, request=dict(REQUEST, features=FEATURES))
        transaction.set_rollback(True)
    assert valid(dict(REQUEST, features=FEATURES)) is True


def test_reverse_sql_is_the_0004_body_verbatim():
    from dj.apps.ledger.migrations import _call_features, _gateway_calls
    body = re.compile(r'FUNCTION ledger\.gateway_metadata_valid\(.*?END \$\$;', re.S)
    assert body.search(_call_features.REVERSE_SQL).group(0) == body.search(_gateway_calls.SQL).group(0)
    # And the forward body differs from it ONLY by the features branch.
    forward = body.search(_call_features.SQL).group(0)
    stripped = re.sub(r"   ELSIF k='features'.*?     END LOOP;\n", '', forward, flags=re.S)
    assert stripped.replace('DECLARE k text;v jsonb;fk text;fv jsonb;', 'DECLARE k text;v jsonb;') == \
        body.search(_gateway_calls.SQL).group(0)
