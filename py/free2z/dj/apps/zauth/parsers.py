"""Small, endpoint-local request parser for public Zcash auth writes."""

from io import BytesIO

from rest_framework.exceptions import APIException
from rest_framework.parsers import JSONParser


# A normal login body is under 300 bytes. Keeping this local avoids imposing a
# site-wide upload limit while ensuring an anonymous caller cannot make JSON
# parsing allocate an unbounded address/signature before validation runs.
ZCASH_AUTH_BODY_MAX_BYTES = 1024


class ZcashAuthRequestTooLarge(APIException):
    status_code = 413
    default_detail = "Zcash authentication request body is too large."
    default_code = "zcash_auth_request_too_large"


class ZcashAuthJSONParser(JSONParser):
    """Parse at most 1 KiB of JSON, including when Content-Length is absent."""

    default_error = "Zcash authentication request body is too large."

    def parse(self, stream, media_type=None, parser_context=None):
        request = (parser_context or {}).get("request")
        content_length = None if request is None else request.META.get(
            "CONTENT_LENGTH"
        )
        try:
            if content_length and int(content_length) > ZCASH_AUTH_BODY_MAX_BYTES:
                raise ZcashAuthRequestTooLarge(self.default_error)
        except (TypeError, ValueError):
            # An invalid/missing length cannot bypass the bounded stream read.
            pass

        body = stream.read(ZCASH_AUTH_BODY_MAX_BYTES + 1)
        if len(body) > ZCASH_AUTH_BODY_MAX_BYTES:
            raise ZcashAuthRequestTooLarge(self.default_error)
        return super().parse(
            BytesIO(body), media_type=media_type, parser_context=parser_context
        )
