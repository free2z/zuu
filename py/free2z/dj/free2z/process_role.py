"""Distinguish serving processes from one-shot Django management commands.

Startup diagnostics are retained for servers and unknown process types. Only
recognized one-shot management commands suppress repetitive provider/task startup
messages. This module imports without Django models because logging initializes
during application setup.
"""

import logging
import sys
from collections.abc import Sequence

#procrastinate's ``extra={"action":...}`` on its startup registration lines
#(procrastinate/periodic.py and procrastinate/blueprints.py, 3.9.0).
PROCRASTINATE_STARTUP_ACTIONS = frozenset({
    "registering_periodic_task",
    "loading_blueprint",
})

#``manage.py <command>`` processes that run forever: the Pub/Sub subscriber
#Deployments in ``k8s/free2z/sub/BUILD.bazel`` (``%{COMMAND}``). They are
#servers in every sense that matters here -- two of them call OpenAI -- so
#they keep their startup lines. ``test_process_role`` reads that BUILD file
#and fails when a subscriber is added there without being listed here.
LONG_RUNNING_COMMANDS = frozenset({
    "runserver",
    "tweet_comments",
    "aiscore_comments",
    "tag_comments",
    "tag_zpages",
    "dyte_download_upload",
    "push_events",
    "page_update_subscriber",
    "describe_zpage_listener",
})


def management_command(argv: Sequence[str]) -> str | None:
    """The management command, if this process is ``manage.py <command>``.

    Like ``db_pooler._command``, except that ``__main__.py`` counts only as
    ``python -m django``: ``python -m pytest`` (how CI runs the suite) leaves
    argv[0] as ``.../pytest/__main__.py`` too, and is not a command.
    """
    if len(argv) < 2:
        return None
    parts = str(argv[0]).split("/")
    program = parts[-1]
    if program in {"manage.py", "django-admin", "django-admin.py"}:
        return str(argv[1])
    if program == "__main__.py" and len(parts) >= 2 and parts[-2] == "django":
        return str(argv[1])
    return None


def is_one_shot_command(argv: Sequence[str] | None = None) -> bool:
    """True for ``manage.py <cmd>`` unless ``<cmd>`` serves (web or worker)."""
    # sys.argv can be absent in an embedded interpreter; that is "unknown",
    # which means loud, never a crash.
    argv = getattr(sys, "argv", ()) if argv is None else argv
    command = management_command(argv)
    if command is None:
        return False
    if command in LONG_RUNNING_COMMANDS:
        return False
    if command == "procrastinate" and "worker" in argv[2:]:
        return False
    return True


class OneShotStartupNoiseFilter(logging.Filter):
    """Drop procrastinate's startup registration lines in one-shot commands.

    A HANDLER filter, not a logger filter: the records are created on
    ``procrastinate.periodic`` / ``procrastinate.blueprints`` and only
    propagate to the ``procrastinate`` logger's handler, and a logger's own
    filters are not consulted for records propagated from its children.
    """

    def __init__(self, name: str = "", argv: Sequence[str] | None = None):
        super().__init__(name)
        # LOGGING instantiates this during django.setup() in EVERY process; a
        # diagnostic filter must never be the reason one fails to boot.
        try:
            self.quiet = is_one_shot_command(argv)
        except Exception:
            self.quiet = False

    def filter(self, record: logging.LogRecord) -> bool:
        if not self.quiet:
            return True
        return getattr(record, "action", None) not in PROCRASTINATE_STARTUP_ACTIONS
