"""Small server-owned promotion decision shared by preview and issuance.

Eligible global and requested-code offers compete; the highest wins. Ties
prefer the global offer. Rates floor the base to four decimals, multiply once,
then floor again. Display estimates apply the separate buffer to that rate.
"""
import re
from decimal import Decimal, ROUND_DOWN
from django.db import connection
from django.db.models import Q
from django.utils import timezone
from . import constants


def normalize_code(value):
    if not isinstance(value, str):
        return None
    value = value.strip(' ')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value, flags=re.ASCII):
        return None
    value = value.upper()
    return value if re.fullmatch(r'[A-Z0-9_-]{1,64}', value, flags=re.ASCII) else None


def select_promotion(code=None, *, at=None, lock=False):
    from dj.apps.economy.models import ZecPromotion
    requested = normalize_code(code)
    candidates = ZecPromotion.objects.filter(Q(code='') | Q(code=requested or '')).order_by('pk')
    if lock:
        candidates = candidates.select_for_update()
    # Lock disabled and not-yet-active candidates too: an admin edit cannot
    # change the decision between selection and the note issuance proof.
    candidates = list(candidates)
    if not lock:
        from dj.apps.economy.models import EconomicPolicy
        if not EconomicPolicy.objects.filter(pk=True,version=1,fenced=False).exists():
            candidates=[]  # The legacy policy-0 writer has no promotion support.
    at = at or (decision_time() if lock else timezone.now())
    eligible = [p for p in candidates if p.enabled and p.ends_at is not None
        and (p.starts_at is None or p.starts_at <= at) and at < p.ends_at]
    chosen = min(eligible, key=lambda p: (-p.multiplier, p.code != '', str(p.pk))) if eligible else None
    code_active = any(p.code == requested for p in eligible) if requested else False
    return chosen, {'requested_code': requested,
        'code_status': 'none' if not code else ('active' if code_active else 'unavailable'),
        'multiplier': str(chosen.multiplier if chosen else Decimal(1)),
        'title': chosen.title if chosen else None,
        'ends_at': chosen.ends_at.isoformat() if chosen else None,
        'code': chosen.code or None if chosen else None}, at


def rates(zec_usd, multiplier=Decimal(1)):
    base = constants.tuzis_per_zec(zec_usd, constants.ZEC_SETTLEMENT_SPREAD)
    actual = (base * multiplier).quantize(Decimal('.0001'), rounding=ROUND_DOWN)
    estimate = (actual * (1 - constants.ZEC_ESTIMATE_BUFFER)).quantize(Decimal('.0001'), rounding=ROUND_DOWN)
    return base, actual, estimate


def decision_time():
    # A single database-clock timestamp is recorded and used by the SQL proof.
    with connection.cursor() as cursor:
        cursor.execute('SELECT clock_timestamp()')
        return cursor.fetchone()[0]
