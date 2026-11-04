"""What a self-registered app may call itself and where it may live.

Third-party developers register through the console with no human in the
loop, so three things a reviewer would otherwise catch are refused here:

* **Lookalike names.** The consent screen's headline is the app's name. A
  non-first-party app may not carry our brand in any case or confusable
  spelling ("FREE2Z", "free 2 z", "freе2z" with a Cyrillic ``е``), and no
  name may carry control, bidi or zero-width characters, which can reorder
  or hide what the user reads.:func:`name_problem` is a *skeleton* check in
  the spirit of UTS: use the vendored Unicode 17 confusables
  table before casefolding, then remove marks and separators and apply
  additional brand-specific lookalike and digit folds. It errs toward refusing -- a developer who legitimately
  needs our name in theirs is a first-party conversation.
* **Origins that are not origins.** ``allowed_origins`` feeds CORS, which
  compares the browser's ``Origin`` header byte for byte. Anything but
  ``https://host[:port]`` in canonical form either never matches (so it is
  a silent misconfiguration) or is not an origin at all.
* **Same-site origins.** A page on ``anything.free2z.cash`` is same-SITE
  with free2z.cash, so ``SameSite=Lax`` does not keep the user's session
  cookie off its requests. An app registering such an origin would get
  credentialed CORS on the OAuth endpoints. It is refused here, and
  :mod:`.cors` refuses it at request time for any row that predates this.
* **Metadata URLs.** ``logo_url``, ``privacy_url`` and ``terms_url`` are
  shown on the consent screen and must be https.

Import-free of models so:mod:`.models` and:mod:`.cors` can both use it.
"""
from __future__ import annotations

import ipaddress
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlsplit

#The brand strings a third-party app name may not contain, as skeletons.
BRAND_SKELETONS: tuple[str, ...] = ("free2z", "free2give")

#Registrable domains that are ours. Any host equal to one of these or
#under it is same-site with the product and receives its Lax cookies.
FIRST_PARTY_SITES: tuple[str, ...] = (
    "free2z.cash",
    "free2z.com",
    "free2z.net",
    "free2give.xyz",
)

#Lookalikes folded onto the Latin letter they imitate, applied AFTER NFKC
#and casefolding (so only lowercase forms are needed). Cyrillic and Greek
#homoglyphs of the letters in our brands and their neighbours, plus the
#digits people substitute for letters. ``2`` is deliberately not folded:
#it is part of the brand.
_CONFUSABLES = {
    # Cyrillic
    "а": "a", "в": "b", "е": "e", "ё": "e", "і": "i", "ї": "i",
    "ј": "j", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c",
    "т": "t", "у": "y", "х": "x", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w",
    "ɡ": "g", "һ": "h", "ӏ": "l", "г": "r",
    # Greek
    "α": "a", "β": "b", "ε": "e", "ζ": "z", "η": "n", "ι": "i", "κ": "k",
    "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "γ": "y",
    # Latin lookalikes that survive NFKC
    "ı": "i", "ȷ": "j", "ʐ": "z", "ʑ": "z", "ƶ": "z", "ȥ": "z", "ɀ": "z",
    "ſ": "s", "ꝛ": "r", "ɾ": "r", "ʀ": "r", "ᴇ": "e", "ꜰ": "f", "ƒ": "f",
    "ẓ": "z", "ᴢ": "z", "ʒ": "z", "з": "z", "զ": "z", "ⲍ": "z",
    "є": "e", "ɛ": "e", "Ƨ": "2", "ƨ": "2", "ƻ": "2",
    # Digits and symbols standing in for letters
    "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s",
    "@": "a", "€": "e", "|": "l", "!": "i",
}
_CONFUSABLES_TABLE = str.maketrans(_CONFUSABLES)


def _unicode_security_data():
    """Load pinned Unicode data; these.txt files ship in djtar's existing glob."""
    directory = Path(__file__).with_name("unicode_data")
    confusables = {}
    for line in (directory / "confusables.txt").read_text().splitlines():
        fields = line.split("#", 1)[0].split(";")
        if len(fields) >= 2:
            confusables[int(fields[0].strip(), 16)] = "".join(
                chr(int(value, 16)) for value in fields[1].split()
            )
    ignorables = set()
    for line in (directory / "default_ignorables.txt").read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        bounds = line.split(";", 1)[0].strip().split("..")
        ignorables.update(range(int(bounds[0], 16), int(bounds[-1], 16) + 1))
    return confusables, ignorables


_UNICODE_CONFUSABLES, _DEFAULT_IGNORABLES = _unicode_security_data()


def _is_invisible_or_control(char: str) -> bool:
    """Cc (control), Cf (format: bidi overrides/isolates, zero-width
    joiners and spaces, the BOM), Co/Cs/Cn, and the line/paragraph
    separators. Ordinary spaces are fine; these are not."""
    category = unicodedata.category(char)
    return ord(char) in _DEFAULT_IGNORABLES or category in {"Cc", "Cf", "Co", "Cs", "Cn", "Zl", "Zp"}


def name_skeleton(name: str) -> str:
    """Both visual UTS  and compatibility readings of the name.

    Compatibility normalization can erase a visual confusable (long-s
    resembles f in UTS  but NFKC changes it to s). Keep the proper
    NFD -> confusables reading independently of our semantic/leet policy.
    """
    visual = unicodedata.normalize("NFD", name).translate(_UNICODE_CONFUSABLES)
    compatible = unicodedata.normalize("NFKC", name).translate(_CONFUSABLES_TABLE)
    compatible = compatible.translate(_UNICODE_CONFUSABLES)

    def compact(text):
        text = unicodedata.normalize("NFD", text.casefold())
        text = "".join(c for c in text if not unicodedata.combining(c))
        text = text.translate(_CONFUSABLES_TABLE)
        # UTS  maps uppercase I to lowercase l. Both readings must
        # match the protected brand, regardless of the source's case.
        return "".join(c for c in text if c.isalpha() or c == "2").replace("l", "i")

    return compact(visual) + " " + compact(compatible)


def name_problem(name: str, *, first_party: bool) -> str | None:
    """Why ``name`` may not be registered, or ``None`` if it may."""
    if any(_is_invisible_or_control(c) for c in name):
        return ("an app name may not contain control, bidirectional or "
                "zero-width characters")
    if name != name.strip():
        return "an app name may not start or end with whitespace"
    if first_party:
        return None
    skeleton = name_skeleton(name)
    for brand in BRAND_SKELETONS:
        if brand in skeleton:
            return ("an app name may not contain \"Free2Z\" or a name that "
                    "looks like it; only Free2Z's own apps may")
    return None


def host_is_first_party_site(host: str | None) -> bool:
    """True when ``host`` is one of:data:`FIRST_PARTY_SITES` or under it."""
    if not host:
        return False
    host = host.strip().rstrip(".").lower()
    return any(host == site or host.endswith("." + site) for site in FIRST_PARTY_SITES)


_DNS_HOST = re.compile(r"[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*")


def _serialized_host(host: str) -> str | None:
    """``host`` as a browser serializes it in ``Origin``, or ``None`` when
    it is not one this module can vouch for. The shapes a browser would
    REWRITE (``127.1``, ``0x7f.1``, a padded IPv6, percent-escapes) are
    refused rather than guessed at: registration succeeding while every
    CORS check fails is the silent misconfiguration this exists to stop."""
    if ":" in host:
        try:
            return f"[{ipaddress.IPv6Address(host).compressed}]"
        except ValueError:
            return None
    if not _DNS_HOST.fullmatch(host):
        return None
    # WHATWG: a host whose last label is numeric is parsed as IPv4, so it
    # must already be the canonical dotted quad.
    if host.rsplit(".", 1)[-1].isdigit() or host.rsplit(".", 1)[-1].startswith("0x"):
        try:
            address = ipaddress.IPv4Address(host)
        except ValueError:
            return None
        return str(address)
    return host


def origin_problem(origin: str) -> str | None:
    """Why ``origin`` is not a registrable allowed origin, or ``None``.

    The only accepted shape is the one a browser sends in ``Origin``:
    ``https://`` + lowercase host + optional non-default port, nothing else.
    """
    if not origin or any(c.isspace() for c in origin):
        return "an origin may not be empty or carry whitespace"
    if "?" in origin:
        return "an origin has no query string"
    if "#" in origin:
        return "an origin has no fragment"
    try:
        parts = urlsplit(origin)
        port = parts.port
    except ValueError:
        return "not a valid origin"
    if parts.scheme != "https":
        return "an allowed origin must be https"
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return "an origin has no user name or password"
    if parts.path:
        return "an origin has no path (not even a trailing slash)"
    host = parts.hostname
    if not host:
        return "an origin needs a host"
    # Browsers send an internationalized host as punycode, so that is the
    # only form that can ever match `Origin` -- and the form the same-site
    # check must judge ("ｆｒｅｅ２ｚ.cash" IS free2z.cash).
    if host.isascii():
        ascii_host = host
    else:
        try:
            ascii_host = host.encode("idna").decode("ascii").lower()
        except UnicodeError:
            return "not a valid host name"
    if host_is_first_party_site(ascii_host):
        return ("an origin on a Free2Z domain is not allowed: it is same-site "
                "with Free2Z and would receive its cookies")
    netloc_host = _serialized_host(ascii_host)
    if netloc_host is None:
        return "not a valid host name"
    canonical = f"https://{netloc_host}" + (f":{port}" if port not in (None, 443) else "")
    if origin != canonical:
        return f"write it exactly as the browser sends it: {canonical}"
    return None


def https_url_problem(url: str) -> str | None:
    """Why a consent-screen metadata URL is refused, or ``None``. Empty is fine."""
    if not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return "not a valid URL"
    if parts.scheme.lower() != "https":
        return "must be an https URL"
    if not parts.hostname:
        return "must name a host"
    if parts.username is not None or parts.password is not None:
        return "may not carry a user name or password"
    return None
