from rest_framework.views import exception_handler
from rest_framework.exceptions import APIException
from rest_framework.response import Response
from rest_framework import status
from django.db import IntegrityError, transaction
from ..serializers import zPageDetailSerializer
from dj.apps.tuzis.ledger import InsufficientFunds, insufficient_funds_payload

# custom exception handler can be used to trigger a modal on a zPage

#: free2z/zuu#1022. The case-insensitive username index (g12f 0110). Every
#: signup and rename path checks ``username__iexact`` first, so reaching the
#: index means two requests raced past that check; the loser gets the same
#: answer the check would have given, not a 500.
USERNAME_CI_CONSTRAINT = "creator_username_ci_unique"
USERNAME_TAKEN = "A user with that username already exists!"


def _violated_constraint(exc):
    diag = getattr(getattr(exc, "__cause__", None), "diag", None)
    return getattr(diag, "constraint_name", None)


class RedirectWithModalException(APIException):
    status_code = 200
    default_detail = "This is a custom redirect exception with modal flag."
    default_code = "redirect_with_modal"

    def __init__(self, page, show_modal=True):
        self.show_modal = show_modal
        self.page = page
        super().__init__(self.default_detail, self.default_code)


def custom_exception_handler(exc, context):
    if isinstance(exc, InsufficientFunds):
        transaction.set_rollback(True)
        return Response(
            insufficient_funds_payload(exc),
            status=status.HTTP_402_PAYMENT_REQUIRED,
        )

    if (
        isinstance(exc, IntegrityError)
        and _violated_constraint(exc) == USERNAME_CI_CONSTRAINT
    ):
        transaction.set_rollback(True)
        return Response(
            {"username": [USERNAME_TAKEN]},
            status=status.HTTP_400_BAD_REQUEST,
        )

    response = exception_handler(exc, context)

    if isinstance(exc, RedirectWithModalException):
        # Swap out the content so that an intrepid person can't
        # pull it out of the response
        exc.page._redact_content = True
        page_serializer = zPageDetailSerializer(
            instance=exc.page,
            context={"request": context.get("request")},
        )

        response.data = {
            'show_modal': exc.show_modal,
            'page': page_serializer.data
        }

    return response
