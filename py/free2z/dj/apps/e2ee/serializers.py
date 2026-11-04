from rest_framework import serializers


class ChatRequestPriceSerializer(serializers.Serializer):
    cost = serializers.IntegerField(
        min_value=1,
        help_text=(
            "Whole 2Z the server will charge for one chat request. The client "
            "never sends an amount; it shows this number and refuses any "
            "`charged` that differs from it."
        ),
    )
    enabled = serializers.BooleanField(
        help_text=(
            "False while new chat requests are switched off; the POST then "
            "answers 503 `chat_requests_disabled` and charges nothing."
        ),
    )


class ChatRequestBodySerializer(serializers.Serializer):
    """An empty JSON object is a complete request."""

    expected_cost = serializers.IntegerField(
        required=False,
        min_value=1,
        help_text=(
            "Optional. The whole-2Z price the user confirmed (from GET "
            "/api/e2ee/chat-requests/price/). When present and different "
            "from the current price, the request is refused with 409 "
            "`price_changed` and nothing is charged. It never sets the "
            "amount: the server always charges its own price."
        ),
    )


class ChatRequestRecipientSerializer(serializers.Serializer):
    username = serializers.CharField()
    handle = serializers.RegexField(
        r"^[a-z0-9_]{1,30}$",
        allow_null=True,
        help_text=(
            "The recipient's messaging handle, or null when the account has "
            "not got one yet. The request is still delivered either way."
        ),
    )
    handle_status = serializers.ChoiceField(choices=("bound", "unclaimed"))


class ChatRequestResultSerializer(serializers.Serializer):
    balance = serializers.DecimalField(
        max_digits=17,
        decimal_places=3,
        help_text=(
            "The sender's 2Z balance right after the ORIGINAL request, as a "
            "decimal string -- the same wire form as donate-idempotent, "
            "because a balance can hold milli-2Z."
        ),
    )
    charged = serializers.DecimalField(
        max_digits=17,
        decimal_places=3,
        help_text="2Z the original request charged (a whole number).",
    )
    replayed = serializers.BooleanField()
    request_id = serializers.UUIDField()
    recipient = ChatRequestRecipientSerializer()


class ChatRequestRateLimitedSerializer(serializers.Serializer):
    code = serializers.ChoiceField(choices=["rate_limited"])
    error = serializers.CharField()
    retry_after = serializers.IntegerField(
        help_text="Seconds until one more request fits in the window.",
    )
