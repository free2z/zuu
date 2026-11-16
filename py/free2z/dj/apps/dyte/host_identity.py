"""Server-authenticated host identities for delayed provider departures.

The claim is unique per mint, so retirement can resolve one participant.
A signature preserves host attribution after takeover and provider deletion.
"""
import uuid

from django.core import signing

SALT = 'dyte.host-participant.v1'


def host_participant_identity(owner_id, claim):
    return 'host_' + signing.Signer(salt=SALT, sep='.').sign(f'{owner_id.hex}.{claim.hex}')


def host_participant_claim(identity, owner_id):
    if not isinstance(identity, str) or not identity.startswith('host_'):
        return None
    try:
        value = signing.Signer(salt=SALT, sep='.').unsign(identity[5:])
    except signing.BadSignature:
        return None
    owner, separator, claim = value.partition('.')
    if (owner == owner_id.hex and separator == '.' and len(claim) == 32
            and all(char in '0123456789abcdef' for char in claim)):
        return uuid.UUID(hex=claim)
    return None


def is_host_participant(identity, owner_id):
    return host_participant_claim(identity, owner_id) is not None
