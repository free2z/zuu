"""AtomicMiddleware must roll back when the view RAISES.

Before the fix, ``AtomicMiddleware`` did ``with transaction.atomic():
response = self.get_response(request)``. Django wraps every inner handler in
``convert_exception_to_response``, so an exception escaping the view came
back to the middleware as an ordinary 500 *response*; DRF does the same for
its own exceptions (``ValidationError`` -> 400) inside ``APIView``, and DRF's
``set_rollback()`` only acts under ``ATOMIC_REQUESTS``, which is off here. The
atomic block therefore exited normally and COMMITTED whatever the view wrote
before it raised.

The rule these tests pin is ``ATOMIC_REQUESTS``'s rule, not a status-code
rule:

* the view RAISED (anything; converted by Django or DRF)  -> roll back;
* the view RETURNED, whatever the status                   -> commit.

The second half is load-bearing: "commit the claim, then ``return
Response(status=4xx)``" is how several endpoints deliberately persist a
single-use claim while refusing the request (Zcash login, idempotency
claims). A blanket "roll back every 4xx" would reopen those replays.

``django_db(transaction=True)`` is MANDATORY. Under the default marker every
test runs inside an atomic block that never commits, the middleware's block is
only a savepoint, and "did the row persist" cannot be observed the way prod
observes it. Real Postgres, real middleware stack, real URL resolution -- the
views below are routed through this module's own ``urlpatterns``.
"""
import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.contrib.auth.models import Group
from django.db import connection
from django.http import Http404, HttpResponse
from django.test import Client
from django.urls import path
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.tuzis.ledger import InsufficientFunds


def _write(request):
    name = request.headers["X-Row-Name"]
    Group.objects.create(name=name)
    return name


# --- plain Django views ----------------------------------------------------

def django_write_then_raise(request):
    _write(request)
    raise RuntimeError("boom after the write")


def django_write_then_404(request):
    _write(request)
    raise Http404("gone after the write")


def django_write_then_return_500(request):
    _write(request)
    return HttpResponse("deliberate", status=500)


def django_write_ok(request):
    _write(request)
    return HttpResponse("ok")


# --- DRF views ---------------------------------------------------------------

class _Base(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    # Every ATOMIC_METHOD takes the same path through the middleware.
    def put(self, request):
        return self.post(request)

    def patch(self, request):
        return self.post(request)

    def delete(self, request):  # an ATOMIC_METHOD since
        return self.post(request)


class DrfWriteThenValidationError(_Base):
    def post(self, request):
        _write(request)
        raise ValidationError({"field": ["invalid after the write"]})


class DrfWriteThenSerializerInvalid(_Base):
    """The most common real shape: save something, then is_valid(raise)."""

    class _S(serializers.Serializer):
        n = serializers.IntegerField()

    def post(self, request):
        _write(request)
        self._S(data={"n": "not a number"}).is_valid(raise_exception=True)
        return Response(status=status.HTTP_201_CREATED)


class DrfWriteThenNotFound(_Base):
    def post(self, request):
        _write(request)
        raise NotFound()


class DrfWriteThenUnhandled(_Base):
    """A non-API exception: DRF's handler returns None and re-raises it."""

    def post(self, request):
        _write(request)
        raise RuntimeError("boom after the write")


class DrfWriteThenInsufficientFunds(_Base):
    """Already rolled back by custom_exception_handler; must stay that way."""

    def post(self, request):
        _write(request)
        raise InsufficientFunds(
            SimpleNamespace(tuzis=Decimal("0")), Decimal("1"),
            balance=Decimal("0"),
        )


class DrfWriteThenReturn409(_Base):
    """Deliberate commit-then-refuse: RETURNED, not raised. Must commit."""

    def post(self, request):
        _write(request)
        return Response({"detail": "claimed"}, status=status.HTTP_409_CONFLICT)


class DrfWriteOk(_Base):
    def post(self, request):
        _write(request)
        return Response(status=status.HTTP_201_CREATED)


class DrfNonAtomicWriteThenRaise(_Base):
    """An opted-out view runs in autocommit: its write is already durable."""

    atomic_request = False

    def post(self, request):
        _write(request)
        raise ValidationError("after the write")


class DrfWriteInCaughtInnerFailure(_Base):
    """A handled inner failure must not poison the request's own write."""

    def post(self, request):
        from django.db import IntegrityError, transaction

        _write(request)
        try:
            with transaction.atomic():
                Group.objects.create(name=request.headers["X-Row-Name"])
        except IntegrityError:
            pass
        return Response(status=status.HTTP_200_OK)


urlpatterns = [
    path("t2101/django/raise", django_write_then_raise),
    path("t2101/django/404", django_write_then_404),
    path("t2101/django/return-500", django_write_then_return_500),
    path("t2101/django/ok", django_write_ok),
    path("t2101/drf/validation", DrfWriteThenValidationError.as_view()),
    path("t2101/drf/serializer", DrfWriteThenSerializerInvalid.as_view()),
    path("t2101/drf/notfound", DrfWriteThenNotFound.as_view()),
    path("t2101/drf/unhandled", DrfWriteThenUnhandled.as_view()),
    path("t2101/drf/402", DrfWriteThenInsufficientFunds.as_view()),
    path("t2101/drf/return-409", DrfWriteThenReturn409.as_view()),
    path("t2101/drf/ok", DrfWriteOk.as_view()),
    path("t2101/drf/non-atomic", DrfNonAtomicWriteThenRaise.as_view()),
    path("t2101/drf/caught-inner", DrfWriteInCaughtInnerFailure.as_view()),
]


def _post(url, method="post"):
    name = f"t2101-{uuid.uuid4()}"
    # raise_request_exception=False: a real client sees the 500 response; the
    # test client would otherwise re-raise the view's exception at us.
    client = Client(raise_request_exception=False)
    response = getattr(client, method)(
        url, data="{}", content_type="application/json",
        HTTP_X_ROW_NAME=name,
    )
    return response, Group.objects.filter(name=name).exists()


pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.urls(__name__),
]


def test_the_engine_is_postgres():
    """The issue was reproduced on sqlite only; this suite is the prod engine."""
    assert connection.vendor == "postgresql"


@pytest.mark.parametrize(
    "url, expected_status",
    [
        ("/t2101/django/raise", 500),
        ("/t2101/django/404", 404),
        ("/t2101/drf/validation", 400),
        ("/t2101/drf/serializer", 400),
        ("/t2101/drf/notfound", 404),
        ("/t2101/drf/unhandled", 500),
        ("/t2101/drf/402", 402),
    ],
)
@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_a_write_followed_by_a_raise_is_rolled_back(url, expected_status, method):
    response, persisted = _post(url, method)
    assert response.status_code == expected_status, response.content
    assert not persisted, (
        f"{method.upper()} {url} raised after writing and got a "
        f"{response.status_code}, but the write COMMITTED: AtomicMiddleware "
        "saw the converted response, not the exception (#2101)"
    )


@pytest.mark.parametrize(
    "url, expected_status",
    [
        # A RETURNED error is the code base's "commit the claim, then refuse".
        ("/t2101/drf/return-409", 409),
        ("/t2101/django/return-500", 500),
        ("/t2101/django/ok", 200),
        ("/t2101/drf/ok", 201),
        ("/t2101/drf/caught-inner", 200),
        # Opted out of the request transaction: autocommit, already durable.
        ("/t2101/drf/non-atomic", 400),
    ],
)
def test_a_returned_response_still_commits(url, expected_status):
    response, persisted = _post(url)
    assert response.status_code == expected_status, response.content
    assert persisted, f"{url} returned normally; its write must commit"


def test_a_rolled_back_request_leaves_the_connection_usable():
    """The next request on the same connection is a clean transaction."""
    first, persisted = _post("/t2101/drf/validation")
    assert first.status_code == 400 and not persisted
    second, persisted = _post("/t2101/drf/ok")
    assert second.status_code == 201 and persisted
    assert not connection.in_atomic_block


# --- run_after_request_transaction: cleanup that must survive the rollback --

def test_a_stale_bearer_token_is_deleted_even_though_the_post_is_rolled_back(
    creator_factory,
):
    """Codex review of: AccountEpochTokenAuthentication deletes a token
    the account has outlived and then raises AuthenticationFailed. On a POST
    that delete is inside AtomicMiddleware's block, which the raise now rolls
    back -- so unless the delete is deferred past the block, the dead token
    comes back and is re-found and re-deleted on every retry."""
    from knox.models import AuthToken
    from rest_framework.test import APIClient

    from dj.apps.g12f.models import Creator

    owner = creator_factory(username="t2101stale")
    instance, raw = AuthToken.objects.create(owner)
    # Move the account past the token's stamp (epochs only ever increase).
    Creator.objects.filter(pk=owner.pk).update(
        kt_account_epoch=owner.kt_account_epoch + 1)

    client = APIClient(raise_request_exception=False)
    client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    # The project's real bearer authenticator on a write route: refused
    # before the view body runs.
    response = client.post("/t2101/drf/bearer-write", {}, format="json")

    assert response.status_code == 401, response.content
    assert not AuthToken.objects.filter(pk=instance.pk).exists(), (
        "the outlived token survived: its delete was rolled back with the "
        "401'd POST's transaction"
    )


class DrfDeferredWriteThenRaise(_Base):
    def post(self, request):
        from dj.util.middleware import run_after_request_transaction

        name = request.headers["X-Row-Name"]
        Group.objects.create(name=name)  # rolled back
        run_after_request_transaction(
            lambda: Group.objects.create(name=f"{name}-after"))
        raise ValidationError("after the write")


class DrfDeferredCallbackFails(_Base):
    def post(self, request):
        from dj.util.middleware import run_after_request_transaction

        def boom():
            raise RuntimeError("cleanup failed")

        run_after_request_transaction(boom)
        _write(request)
        return Response(status=status.HTTP_201_CREATED)


class DrfBearerWrite(APIView):
    from dj.apps.ktauth.authentication import AccountEpochTokenAuthentication
    from rest_framework.permissions import IsAuthenticated

    authentication_classes = [AccountEpochTokenAuthentication]
    permission_classes = [IsAuthenticated]

    def post(self, request):
        return Response(status=status.HTTP_201_CREATED)


urlpatterns += [
    path("t2101/drf/bearer-write", DrfBearerWrite.as_view()),
    path("t2101/drf/deferred", DrfDeferredWriteThenRaise.as_view()),
    path("t2101/drf/deferred-fails", DrfDeferredCallbackFails.as_view()),
]


def test_a_deferred_write_commits_after_the_request_rolls_back():
    name = f"t2101-{uuid.uuid4()}"
    response = Client(raise_request_exception=False).post(
        "/t2101/drf/deferred", data="{}", content_type="application/json",
        HTTP_X_ROW_NAME=name,
    )
    assert response.status_code == 400
    assert not Group.objects.filter(name=name).exists()
    assert Group.objects.filter(name=f"{name}-after").exists()


def test_a_failing_deferred_callback_does_not_change_the_response():
    response, persisted = _post("/t2101/drf/deferred-fails")
    assert response.status_code == 201, response.content
    assert persisted


def test_outside_a_request_transaction_the_callback_runs_immediately():
    from dj.util.middleware import run_after_request_transaction

    ran = []
    run_after_request_transaction(lambda: ran.append(True))
    assert ran == [True]
