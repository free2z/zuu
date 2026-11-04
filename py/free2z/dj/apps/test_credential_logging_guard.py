"""Repository guard against sending credential-named values to log sinks."""

import ast
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PY_ROOT = ROOT / "py" / "free2z"
LOG_METHODS = {
    "debug", "info", "log", "warning", "warn", "error", "exception", "critical",
}
DIRECT_SINKS = {"print", "pprint"}
SENSITIVE_PARTS = (
    "api_key",
    "api_secret",
    "client_secret",
    "consumer_key",
    "consumer_secret",
    "oauth_token",
    "oauth_verifier",
    "access_token",
    "refresh_token",
    "viewing_key",
    "private_key",
    "password",
    "secret",
    "credential",
)
SENSITIVE_PRODUCERS = {
    "fetch_access_token",
    "fetch_request_token",
    "get_request_token",
    "authorization_url",
}


def _normalized(value):
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value)
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def _sensitive_name(value):
    normalized = _normalized(value)
    return any(part in normalized for part in SENSITIVE_PARTS)


def _call_name(call):
    function = call.func
    if isinstance(function, ast.Name):
        return function.id
    if isinstance(function, ast.Attribute):
        return function.attr
    return ""


def _assigned_names(node):
    if isinstance(node, ast.Name):
        return {node.id}
    names = set()
    if isinstance(node, (ast.Tuple, ast.List)):
        for element in node.elts:
            names.update(_assigned_names(element))
    return names


def _expression_is_sensitive(node, tainted):
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and (
            child.id in tainted or _sensitive_name(child.id)
        ):
            return True
        if isinstance(child, ast.Attribute) and _sensitive_name(child.attr):
            return True
        if isinstance(child, ast.Subscript):
            key = child.slice
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                if _sensitive_name(key.value):
                    return True
        if isinstance(child, ast.Dict):
            for key in child.keys:
                if (
                    isinstance(key, ast.Constant)
                    and isinstance(key.value, str)
                    and _sensitive_name(key.value)
                ):
                    return True
        if isinstance(child, ast.Call):
            name = _call_name(child)
            if name in SENSITIVE_PRODUCERS:
                return True
            if name == "get" and child.args:
                key = child.args[0]
                if (
                    isinstance(key, ast.Constant)
                    and isinstance(key.value, str)
                    and _sensitive_name(key.value)
                ):
                    return True
    return False


def _assignment_value_is_sensitive(node, tainted):
    """Propagate credential taint through local value construction.

    This deliberately reuses the sink expression walk. Otherwise an f-string,
    concatenation, collection, or innocent-looking wrapper call can launder a
    credential before a later log call.
    """
    if isinstance(node, ast.Call):
        name = _call_name(node)
        if name in SENSITIVE_PRODUCERS:
            return True
        if name == "get" and node.args:
            key = node.args[0]
            if (
                isinstance(key, ast.Constant)
                and isinstance(key.value, str)
                and _sensitive_name(key.value)
            ):
                return True
        # Propagate values passed through helper/wrapper calls, but not taint
        # from the receiver object of a method call. A configured OAuth client
        # may contain a secret without making every response from `.get()` a
        # credential value.
        values = [*node.args, *(keyword.value for keyword in node.keywords)]
        return any(_expression_is_sensitive(value, tainted) for value in values)
    return _expression_is_sensitive(node, tainted)


_SCOPE_NODES = (
    ast.Module,
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.Lambda,
    ast.ClassDef,
)


def _nodes_in_scope(scope):
    """Return nodes owned by one lexical scope, excluding nested scopes."""
    nodes = []

    class ScopeVisitor(ast.NodeVisitor):
        def generic_visit(self, node):
            if node is not scope and isinstance(node, _SCOPE_NODES):
                return
            nodes.append(node)
            super().generic_visit(node)

    ScopeVisitor().visit(scope)
    return nodes


def _sink_aliases(tree):
    aliases = set(DIRECT_SINKS)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in {"logging", "pprint"}:
            for item in node.names:
                if item.name in LOG_METHODS | DIRECT_SINKS:
                    aliases.add(item.asname or item.name)
    return aliases


def _is_sink(call, aliases):
    if isinstance(call.func, ast.Name):
        return call.func.id in aliases
    return isinstance(call.func, ast.Attribute) and call.func.attr in LOG_METHODS


def _violations(source, filename):
    tree = ast.parse(source, filename=filename)
    aliases = _sink_aliases(tree)
    findings = []
    scopes = [tree, *(
        node for node in ast.walk(tree)
        if node is not tree and isinstance(node, _SCOPE_NODES)
    )]
    for scope in scopes:
        scope_nodes = _nodes_in_scope(scope)
        tainted = set()

        # A fixed point covers aliases and constructed values inside a scope
        # without leaking common local names between unrelated functions.
        changed = True
        while changed:
            changed = False
            for node in scope_nodes:
                if isinstance(node, ast.Assign):
                    targets = set().union(
                        *(_assigned_names(t) for t in node.targets)
                    )
                    value = node.value
                elif isinstance(node, ast.AnnAssign):
                    targets = _assigned_names(node.target)
                    value = node.value
                else:
                    continue
                if (
                    value is not None
                    and _assignment_value_is_sensitive(value, tainted)
                ):
                    new = targets - tainted
                    if new:
                        tainted.update(new)
                        changed = True

        for node in scope_nodes:
            if not isinstance(node, ast.Call) or not _is_sink(node, aliases):
                continue
            values = [*node.args, *(keyword.value for keyword in node.keywords)]
            implicit_sensitive_exception = (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == "exception"
                and bool(tainted)
            )
            if implicit_sensitive_exception or any(
                _expression_is_sensitive(value, tainted) for value in values
            ):
                findings.append(f"{filename}:{node.lineno}")
    return findings


def _production_python_files():
    for path in PY_ROOT.rglob("*.py"):
        relative = path.relative_to(PY_ROOT)
        if path.name.startswith("test_") or "tests" in relative.parts:
            continue
        yield path


def test_production_python_never_logs_credential_named_values():
    findings = []
    for path in _production_python_files():
        findings.extend(_violations(path.read_text(), str(path.relative_to(ROOT))))
    assert findings == [], "credential value reaches print/log sink:\n" + "\n".join(findings)


def test_guard_detects_the_original_twitter_leak_shapes():
    source = """
import logging
import os
oauth_token = request.query_params.get('oauth_token')
print(oauth_token)
print(os.environ.get('TWITTER_API_KEY_SECRET'))
response = oauth.fetch_request_token(url)
logging.info(response)
wrapped = client.get_request_token(url)
logging.info(wrapped)
logging.log(logging.INFO, oauth_token)
"""
    assert len(_violations(source, "positive_control.py")) == 5


def test_guard_detects_implicit_sensitive_exception_output():
    source = """
try:
    response = oauth.fetch_access_token(url)
except Exception:
    logger.exception("OAuth failed")
"""
    assert _violations(source, "exception_control.py") == [
        "exception_control.py:5",
    ]


def test_guard_propagates_taint_through_value_construction():
    source = """
oauth_token = request.query_params["oauth_token"]
formatted = f"callback token={oauth_token}"
concatenated = "callback token=" + oauth_token
collection = [oauth_token]
wrapped = sanitize_for_display(oauth_token)
logger.info(formatted)
logger.info(concatenated)
logger.info(collection)
logger.info(wrapped)
"""
    assert len(_violations(source, "constructed_values.py")) == 4


def test_guard_allows_static_non_sensitive_events():
    source = "logger.info('twitter_oauth1_callback_received')\n"
    assert _violations(source, "safe_event.py") == []
