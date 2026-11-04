import contextvars
import logging
import traceback

from django.db import DEFAULT_DB_ALIAS, transaction

logger = logging.getLogger(__name__)
from django.urls import resolve

# Only mutating methods get the request-wide transaction.
#
# DELETE joined in. Before that it ran in autocommit, so a DELETE that
# wrote twice and then failed kept the first write, and storage could be
# deleted before the row that pointed at it. The audit that justified adding
# it (every DELETE route, what it writes, what it locks, what it calls) is in
# `dj/apps/g12f/test_atomic_delete_requests.py`, which also fails on any
# DELETE route that opts out without being listed there. The extra lock time
# is the request's own auth/permission/render work: no DELETE path makes an
# external call inside the transaction (storage deletion goes through the
# upload deletion outbox, after COMMIT), and a cascade was already one
# transaction inside Django's `Collector`.
ATOMIC_METHODS = frozenset({'PUT', 'POST', 'PATCH', 'DELETE'})


def resolve_view(request):
    """The view callable this request will dispatch to, or ``None``.

    Middleware runs before URL resolution, so we resolve a second time here.
    The resolver is cached per URLconf, so this is a dict/regex walk (measured
    at 22-31us per write request, 404 walk included), not a meaningful cost --
    and it only happens for the mutating methods below.

    Catches EVERYTHING, not just ``Resolver404``. This runs on every write
    request in the app, and the only thing the caller does with the answer is
    decide whether to open a transaction. Letting an unexpected resolver error
    escape from here would convert a request that was going to be a clean 404
    (or a 400, or anything else Django handles downstream) into a 500 raised
    out of middleware -- a bigger failure than the one it reported. Returning
    ``None`` is fail-closed: the request keeps the transaction it has always
    had, and whatever the real error was surfaces from Django's own resolution
    a moment later, where it is handled properly.
    """
    try:
        return resolve(
            request.path_info, urlconf=getattr(request, 'urlconf', None)
        ).func
    except Exception:
        return None


def wants_atomic_request(request):
    """False when the target view has opted out of the request-wide transaction.

    Three ways to opt out, so the escape hatch works for anything routed here:

    * ``@transaction.non_atomic_requests`` on a plain view function (Django's
      own marker, honoured here so the two mechanisms agree);
    * ``atomic_request = False`` on a DRF ``APIView`` / ``ViewSet`` subclass
      (``as_view()`` records the class on ``view.cls``);
    * ``atomic_request = False`` on a Django CBV (``view.view_class``).

    Opting out is NOT a way to avoid thinking about transactions -- it means
    the view takes responsibility for its own ``transaction.atomic()`` blocks.
    The reason it exists is issue: the AI chat endpoint spends 10-90s
    inside a provider stream, and a request-wide transaction turns that into a
    Cloud SQL connection sitting ``idle in transaction`` for the entire
    generation (xmin pinned, vacuum held back, a connection slot burned in a
    state every monitoring tool reports as idle).
    """
    view = resolve_view(request)
    if view is None:
        return True
    if DEFAULT_DB_ALIAS in getattr(view, '_non_atomic_requests', ()):
        return False
    view_class = getattr(view, 'cls', None) or getattr(
        view, 'view_class', None)
    if request.method in getattr(view_class, 'non_atomic_methods', ()):
        return False
    if getattr(view_class, 'atomic_request', True) is False:
        return False
    return True


NON_ATOMIC_POST_PATHS = frozenset({
    # Password-reset issuance commits its token before contacting SMTP. A
    # request-wide transaction would otherwise keep the Creator row lock and
    # the uncommitted token open through the provider call.
    '/api/emails/reset-password',
    # Confirmation resend follows the same account-first lock and sends mail
    # after its rotation commits; do not hold that lock through SMTP.
    '/api/emails/resend',
    # Address rotation also locks the account and sends confirmation mail only
    # after its explicit transaction commits.
    '/api/emails/add',
    # Stripe account proof and Checkout Session creation are external network
    # calls. The intent insert commits first in autocommit, so a webhook can
    # always resolve its metadata; no Cloud SQL transaction remains open while
    # Stripe responds.
    '/api/stripe/create-checkout-session',
    # Signature verification is local, provider account/event proof is bounded
    # but external, and fulfillment opens its own narrow transaction only after
    # those calls complete. Never hold a request-wide DB transaction while
    # Stripe is slow or retrying delivery.
    '/api/stripe/webhook',
})


#The callables registered by:func:`run_after_request_transaction` while
#this context is inside AtomicMiddleware's block; ``None`` outside one.
_AFTER_REQUEST_TRANSACTION = contextvars.ContextVar(
    'atomic_middleware_after_request_transaction', default=None)


def run_after_request_transaction(fn):
    """Run ``fn`` once the request's transaction has ended, however it ended.

    The escape hatch for a write that must persist EVEN WHEN the request is
    rolled back: cleanup performed on the way to a refusal, such as
    ``AccountEpochTokenAuthentication`` deleting a token the account has
    outlived and then raising ``AuthenticationFailed``. Written inline, that
    delete is inside AtomicMiddleware's block and the raise rolls it back, so
    the dead row is re-found and re-deleted on every retry.

    Inside AtomicMiddleware's block, ``fn`` is queued and run in autocommit
    after the block commits or rolls back. Anywhere else (GET, an opted-out
    view, a management command) there is no request transaction to
    wait for, so ``fn`` runs now. Either way it runs exactly once.

    An exception from a QUEUED ``fn`` is logged, not raised: the response has
    already been decided, and a failed cleanup must not turn a 401 into a 500.
    ``fn`` must therefore be idempotent and safe to lose (it is re-derived on
    the next request) -- this is for cleanup and bookkeeping, never for a
    write the product's correctness depends on.
    """
    queue = _AFTER_REQUEST_TRANSACTION.get()
    if queue is None:
        fn()
    else:
        queue.append(fn)


def _drain(queue):
    for fn in queue:
        try:
            fn()
        except Exception:
            logger.exception(
                'run_after_request_transaction callback %r failed', fn)


#Set on the ``HttpRequest`` by:meth:`AtomicMiddleware.process_exception`
#when the view raised. Private to this module.
_VIEW_RAISED = '_atomic_middleware_view_raised'


def response_came_from_exception(request, response):
    """True when ``response`` stands in for an exception the view raised.

    This is the ``ATOMIC_REQUESTS`` rule, not a status-code rule:

    * Django turns an exception escaping the view -- anything, ``Http404``
      and ``PermissionDenied`` included -- into a response *inside*
      ``AtomicMiddleware``'s block (``convert_exception_to_response`` wraps
      every inner handler), so the block used to see a normal return and
      COMMIT whatever the view wrote first. ``process_exception`` sees every
      one of those, and flags the request.
    * DRF catches its own exceptions (``ValidationError``, ``NotFound``,
      ``PermissionDenied``,...) in ``APIView.handle_exception`` and returns
      a ``Response`` with ``response.exception = True``. DRF's own
      ``set_rollback()`` is a no-op here because ``ATOMIC_REQUESTS`` is off.

    A view that RETURNS an error response (``return Response(..., status=
    409)``) is deliberately NOT a rollback: that is how the code base spells
    "commit the claim, then refuse" (the Zcash login challenge claim, the
    idempotency claims). Raising means "undo"; returning means "keep".
    """
    return bool(
        getattr(request, _VIEW_RAISED, False)
        or getattr(response, 'exception', False)
    )


class AtomicMiddleware:
    """One ``transaction.atomic()`` around every PUT/POST/PATCH/DELETE request.

    Commits when the view returns, and ROLLS BACK when the view raised --
    including an exception Django or DRF has already converted into a 4xx/5xx
    response by the time it gets back here. See
    :func:`response_came_from_exception` for exactly what counts.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def process_exception(self, request, exception):
        # Only records the fact; returns None so Django's normal handling
        # (DEBUG page, 404/403/400 handlers, got_request_exception, logging)
        # produces the response exactly as before.
        setattr(request, _VIEW_RAISED, True)
        return None

    def __call__(self, request):
        # Two independent opt-outs, both required. The path list is the older,
        # blunter one (the email endpoints, which must not hold a row lock
        # through SMTP); `wants_atomic_request` is the view-level one added for
        #. `wants_atomic_request` costs a URL resolution, so short-circuit
        # on the cheap checks first.
        is_non_atomic_path = request.path_info.rstrip('/') in NON_ATOMIC_POST_PATHS
        if (
            request.method in ATOMIC_METHODS
            and not is_non_atomic_path
            and wants_atomic_request(request)
        ):
            queue = []
            token = _AFTER_REQUEST_TRANSACTION.set(queue)
            try:
                with transaction.atomic():
                    response = self.get_response(request)
                    if response_came_from_exception(request, response):
                        # The view's own atomic blocks have all exited by
                        # now, so this marks OUR block: it rolls back on exit
                        # instead of committing a write the view meant to be
                        # undone.
                        transaction.set_rollback(True)
            finally:
                _AFTER_REQUEST_TRANSACTION.reset(token)
                _drain(queue)
        else:
            response = self.get_response(request)

        return response


class ExceptionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        try:
            response = self.get_response(request)
        except Exception as e:
            traceback.print_exc()
            raise e
        return response
