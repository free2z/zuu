"""Bounded retry strategies for jobs with different failure classes."""
from __future__ import annotations

import random
from dataclasses import dataclass

from google.api_core.exceptions import GoogleAPICallError
from procrastinate.retry import BaseRetryStrategy, RetryDecision


@dataclass(frozen=True)
class JitteredRetryStrategy(BaseRetryStrategy):
    """Full-jitter exponential retry policy.

    ``max_attempts`` follows Procrastinate's contract: it is the number of
    retries after the initial run. On the first run ``job.attempts`` is zero.
    """

    max_attempts: int
    base: float
    cap: float

    def __post_init__(self):
        if self.max_attempts < 0:
            raise ValueError("max_attempts must be non-negative")
        if self.base <= 0 or self.cap <= 0:
            raise ValueError("base and cap must be positive")

    def get_retry_decision(self, *, exception, job):
        if job.attempts >= self.max_attempts:
            return None
        ceiling = min(self.cap, self.base * (2 ** job.attempts))
        return RetryDecision(retry_in={"seconds": random.uniform(0, ceiling)})


@dataclass(frozen=True)
class SplitRetryStrategy(BaseRetryStrategy):
    """Select an infrastructure or media retry policy by exception type."""

    infra: BaseRetryStrategy
    media: BaseRetryStrategy
    infra_exceptions: tuple[type[BaseException], ...]
    infra_status_codes: tuple[int, ...] = ()
    infra_oserror_errnos: tuple[int, ...] = ()

    @property
    def max_attempts(self):
        """Largest retry allowance across the selected strategies."""
        values = (
            getattr(self.infra, "max_attempts", None),
            getattr(self.media, "max_attempts", None),
        )
        return max((value for value in values if value is not None), default=None)

    def get_retry_decision(self, *, exception, job):
        is_infra = isinstance(exception, self.infra_exceptions)
        if isinstance(exception, GoogleAPICallError):
            is_infra = exception.code in self.infra_status_codes
        elif isinstance(exception, OSError) and not is_infra:
            # requests.HTTPError also inherits OSError; only explicit known
            # resource-pressure errno values qualify on this branch.
            is_infra = exception.errno in self.infra_oserror_errnos
        strategy = self.infra if is_infra else self.media
        return strategy.get_retry_decision(exception=exception, job=job)
