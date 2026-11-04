"""Read the activation owner's readiness flag once at HTTP process startup."""
import logging
from pathlib import Path

logger = logging.getLogger('dj.free2z.sdk_activation')


def _unavailable(reason):
    # Fixed reason codes only: never log the file path, contents or exception.
    logger.error('{"event":"sdk_ai_activation_unavailable","reason":"%s"}', reason)
    return False


def sdk_ai_grants_enforced(environ):
    path = environ.get('SDK_AI_GRANTS_ENFORCED_FILE', '')
    if path:
        if environ.get('DBNAME') != 'prod':
            return _unavailable('nonproduction_file')
        try:
            value = Path(path).read_text(encoding='utf-8').strip()
        except FileNotFoundError:
            # An absent optional ConfigMap/key never falls through to envFrom.
            return False
        except (OSError, UnicodeError, ValueError):
            return _unavailable('unreadable_file')
    else:
        value = environ.get('SDK_AI_GRANTS_ENFORCED', 'false')
    if value not in ('true', 'false'):
        return _unavailable('invalid_value')
    return value == 'true'
