"""Isolated, bounded recovery-mail provider invocation.

Input is a pickle produced by the parent over an anonymous pipe. Never log the
message, provider exception, address, or credential. Exit codes carry only the
delivery outcome. This process never accesses the parent's database connection.
"""
import os
import pickle
import signal
import sys


def bind_parent(expected_parent):
    """Linux only: die with the gate owner, including the pre-prctl race."""
    if not sys.platform.startswith('linux') or os.getppid() != expected_parent:
        return False
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        return False
    return os.getppid() == expected_parent


def main():
    try:
        if len(sys.argv) != 2 or not bind_parent(int(sys.argv[1])):
            return 23
        message, backend, timeout = pickle.load(sys.stdin.buffer)
        import django
        django.setup()
        from django.conf import settings
        from dj.apps.emails.backends import delivery_outcome_unknown

        settings.EMAIL_BACKEND = backend
        settings.EMAIL_SEND_TIMEOUT_SECONDS = timeout
        if message is None:
            return 0
        try:
            accepted = message.send()
        except Exception as exc:
            return 22 if delivery_outcome_unknown(exc) else 21
        return 0 if accepted else 20
    except BaseException:
        # An unexplained failure could occur after provider acceptance.
        return 22


if __name__ == '__main__':
    os._exit(main())
