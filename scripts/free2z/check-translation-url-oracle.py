#!/usr/bin/env python3
"""Free2Z application check: check translation url oracle."""
import importlib.util
import json
import pathlib
import re
import subprocess
import sys
from html import unescape
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[2]
UI = ROOT / "ts/svelte/free2z"
FIXTURE = ROOT / "py/free2z/dj/apps/g12f/test_translation_url_bypasses.json"
ZCASH_FIXTURE = ROOT / "py/free2z/dj/apps/g12f/test_translation_zcash_bypasses.json"
SAFETY = ROOT / "py/free2z/dj/apps/g12f/translation/safety.py"

KNOWN_RENDERED = {
    "link_title_backticks",
    "math_display_backticks",
    "math_inline_paren_backticks",
    "raw_html_attribute_backticks",
    "userinfo_in_link_destination",
    "userinfo_in_autolink",
    "userinfo_in_autolink_after_source_host",
    "userinfo_in_image_source",
    "fence_closed_by_backticks_tilde",
    "fence_opener_inside_html_block",
    "table_cell_code_span_crosses_pipe",
    "bare_url_backtick_userinfo",
    "bare_url_quote_userinfo",
    "bare_url_paren_userinfo",
    "bare_url_bracket_userinfo",
    "bare_email_address",
    "glued_url_after_period_quote_userinfo",
    "glued_url_after_period",
    "glued_url_after_cjk",
    "glued_url_after_digit",
    "glued_www_after_letter",
}

RENDER_JS = r"""
const { createServer } = await import(process.cwd() + "/node_modules/vite/dist/node/index.js");
const server = await createServer({
  root: process.cwd(), appType: "custom", logLevel: "silent",
  server: { middlewareMode: true },
});
try {
  const md = await server.ssrLoadModule("/src/lib/utils/markdown.ts");
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const out = JSON.parse(input).map((text) => {
    const html = md.processMarkdown(text);
    const urls = [
      ...[...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/<(?:img|iframe|video|audio|source)\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]),
    ];
    const hosts = [];
    for (const raw of urls) {
      const href = raw.replaceAll("&amp;", "&");
      try {
        const u = new URL(href, "https://free2z.invalid/");
        hosts.push(u.protocol === "mailto:" ? "mailto:" + u.pathname : u.host);
      } catch { hosts.push("<unparseable:" + href + ">"); }
    }
    return { html, urls, hosts };
  });
  console.log("__ORACLE__" + JSON.stringify(out));
} finally {
  await server.close();
}
"""


def load_safety():
    sys.path.insert(0, str(ROOT / "py" / "free2z"))
    spec = importlib.util.spec_from_file_location("translation_safety", SAFETY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render(texts):
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", RENDER_JS],
        input=json.dumps(texts), capture_output=True, text=True, cwd=UI,
    )
    lines = [l for l in proc.stdout.split("\n") if l.startswith("__ORACLE__")]
    if proc.returncode != 0 or not lines:
        sys.stderr.write(proc.stderr[-4000:])
        sys.stderr.write(
            "\ncould not render: needs node >= 24 and `npm ci` in "
            f"{UI.relative_to(ROOT)}\n"
        )
        sys.exit(2)
    return json.loads(lines[-1][len("__ORACLE__"):])


class VisiblePaymentText(HTMLParser):
    """Rendered text excluding KaTeX's inline transparent/hidden layout nodes."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        display_hidden, visibility_hidden, transparent = (
            self.stack[-1][1:] if self.stack else (False, False, False)
        )
        declarations = {
            key.strip().lower(): value.strip().lower()
            for declaration in dict(attrs).get("style", "").split(";")
            if ":" in declaration
            for key, value in [declaration.split(":", 1)]
        }
        display_hidden |= declarations.get("display") == "none"
        if "visibility" in declarations:
            visibility_hidden = declarations["visibility"] == "hidden"
        color = declarations.get("color")
        if color and color not in {"inherit", "currentcolor", "unset"}:
            transparent = (
                color == "transparent"
                or bool(re.fullmatch(r"#[0-9a-f]{3}0|#[0-9a-f]{6}00", color))
            )
        if tag not in {"br", "hr", "img", "input", "source", "wbr", "meta", "link"}:
            self.stack.append((tag, display_hidden, visibility_hidden, transparent))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        if not self.stack or not any(self.stack[-1][1:]):
            self.parts.append(data)


def visible_payment_text(html):
    parser = VisiblePaymentText()
    parser.feed(html)
    # KaTeX emits an invisible U+200B strut for box layout.
    return "".join(parser.parts).replace("\u200b", "")


def main():
    safety = load_safety()
    fixture = json.loads(FIXTURE.read_text())
    source = fixture["source"]
    cases = fixture["cases"]
    benign = fixture["benign"]
    outputs = [source + "\n" + c["output"] + "\n" for c in cases]
    outputs += [b["output"] for b in benign]
    rendered = render([source] + outputs)
    source_hosts = set(rendered[0]["hosts"])

    failures = []
    new_host_count = 0
    for case, text, out in zip(
        cases + benign, outputs, rendered[1:]
    ):
        is_benign = case in benign
        new_hosts = sorted(set(out["hosts"]) - source_hosts)
        codes = [v.code for v in safety.find_violations(source, text)]
        fatal = "url_not_in_source" in codes or "unsafe_url_scheme" in codes
        new_host_count += bool(new_hosts)
        if new_hosts and not fatal:
            failures.append(f"RENDERED, NOT FATAL  {case['name']}: {new_hosts} codes={codes}")
        if case["name"] in KNOWN_RENDERED and not new_hosts:
            failures.append(f"known bypass no longer renders a new host  {case['name']}: {out['urls']}")
        if is_benign and (new_hosts or fatal):
            failures.append(f"benign case flagged  {case['name']}: hosts={new_hosts} codes={codes}")

    zcash_fixture = json.loads(ZCASH_FIXTURE.read_text())
    address = zcash_fixture["address"]
    transparent_address = zcash_fixture["transparent_address"]
    split = 40
    rendered_cases = {
        "intraword_emphasis": address[:split] + "**" + address[split:] + "**",
        "html_entity": address[:split] + "&#" + str(ord(address[split])) + ";" + address[split + 1:],
        "link_text_and_title": (
            address[:split] + "[" + address[split:split + 8]
            + '](https://free2z.cash "x")' + address[split + 8:]
        ),
        "zero_width": address[:split] + "\u200b" + address[split:],
        "soft_hyphen": address[:split] + "\u00ad" + address[split:],
        "fullwidth_digit": address[:address.index("4")] + "４" + address[address.index("4") + 1:],
        "glued_to_word": "anX" + address,
        "unclosed_link_syntax": '](https://free2z.cash "unclosed\n' + address,
        "unpaired_link_closer": '](https://free2z.cash "' + address + '")',
        "literal_link_closer_before_address": '`](` ' + address + ' `)`',
        "apostrophe_link_destination_before_address": (
            "[read](https://free2z.cash/a'b)\n\nDonate to " + address
        ),
        "display_math_splits_address": address[:40] + "$$" + address[40:80] + "$$" + address[80:],
        "inline_math_splits_address": address[:40] + r"\(" + address[40:80] + r"\)" + address[80:],
        "combining_grapheme_joiner": address[:40] + "\u034f" + address[40:],
        "variation_selector": address[:40] + "\ufe0f" + address[40:],
        "cyrillic_homoglyph": address[:address.index("a")] + "а" + address[address.index("a") + 1:],
        "blank_line_breaks_link_label": (
            '[prefix\n\n](https://free2z.cash "' + address + '")'
        ),
        "malformed_balanced_link_destination": (
            '[x](https://free2z.cash Donate ' + address + ')'
        ),
        "inline_code_link_syntax": (
            '`[prefix](https://free2z.cash "' + address + '")`'
        ),
        "fenced_code_link_syntax": (
            '```markdown\n[prefix](https://free2z.cash "' + address + '")\n```'
        ),
        "address_with_bold_suffix": (
            address[:40] + "**" + address[40:] + "**qqqqqqqq"
        ),
        "address_with_long_bech32_suffix": (
            address[:40] + "**" + address[40:] + "**" + "q" * 100
        ),
        "address_with_formatted_prose_suffix": (
            address[:40] + "**" + address[40:] + "**" + "*payments*."
        ),
        "reference_link_inside_address": (
            address[:40] + "[" + address[40:48] + "][r]" + address[48:]
            + "\n\n[r]: https://free2z.cash"
        ),
        "reference_shortcut_inside_address": (
            address[:40] + "[" + address[40:48] + "]" + address[48:]
            + "\n\n[" + address[40:48] + "]: https://free2z.cash"
        ),
        "reference_collapsed_inside_address": (
            address[:40] + "[" + address[40:48] + "][]" + address[48:]
            + "\n\n[" + address[40:48] + "]: https://free2z.cash"
        ),
        "link_title_backticks_before_address": (
            "[x](https://free2z.cash \"`\") Donate "
            + address[:40] + "**" + address[40:] + "** `end`"
        ),
        "triple_emphasis_inside_address": (
            address[:40] + "***" + address[40:] + "***"
        ),
        "single_tilde_strikethrough_inside_address": (
            address[:40] + "~" + address[40:] + "~"
        ),
        "math_backticks_before_emphasized_address": (
            "\\(a`b\\) " + address[:40] + "**" + address[40:]
            + "** \\(c`d\\)"
        ),
        "unequal_emphasis_runs_inside_address": (
            address[:40] + "*" + address[40:] + "**"
        ),
        "zip320_tex": zcash_fixture["tex_address"],
        "transparent_address_split_by_math": (
            transparent_address[:12] + "$$" + transparent_address[12:24]
            + "$$" + transparent_address[24:]
        ),
        "katex_text_command_inside_address": (
            address[:40] + r"\(\text{" + address[40:80] + r"}\)" + address[80:]
        ),
        "katex_color_command_inside_address": (
            address[:40] + r"\(\color{red}{" + address[40:80] + r"}\)" + address[80:]
        ),
        "katex_textcolor_command_inside_address": (
            address[:40] + r"\(\textcolor{red}{" + address[40:80] + r"}\)" + address[80:]
        ),
        "katex_inline_math_inside_address": (
            address[:40] + r"\(" + address[40:48] + r"\)" + address[48:]
        ),
        "sprout": zcash_fixture["sprout_address"],
    }
    zcash_outputs = [
        f"Donate {rendered_cases[name]}." for name in zcash_fixture["cases"]
    ]
    zcash_rendered = render([zcash_fixture["source"]] + zcash_outputs)
    source_addresses = safety.extract_zcash_addresses(zcash_fixture["source"])
    for name, text, rendered in zip(zcash_fixture["cases"], zcash_outputs, zcash_rendered[1:]):
        html_text = re.sub(
            r"</p>\s*<p(?:\s[^>]*)?>", "\n\n", rendered["html"]
        )
        html_text = unescape(re.sub(r"<[^>]*>", "", html_text))
        expected = {
            "zip320_tex": zcash_fixture["tex_address"],
            "transparent_address_split_by_math": transparent_address,
            "sprout": zcash_fixture["sprout_address"],
        }.get(name, address)
        extracted = safety.extract_zcash_addresses(html_text)
        codes = [v.code for v in safety.find_violations(zcash_fixture["source"], text)]
        if expected not in extracted:
            failures.append(f"rendered payment address not extracted  {name}: {sorted(extracted)}")
        if expected in source_addresses or "url_not_in_source" not in codes:
            failures.append(f"payment-address bypass not fatal  {name}: codes={codes}")

    # Copied code fragments are not payment authorization. The complete
    # checksum-valid address must be scanned before deciding whether the
    # source authorized that exact destination; a fragment such as `u1` must
    # not mask translated characters that complete it.
    boundary_cases = [
        (
            "copied_code_prefix",
            "Unified addresses begin with `u1`.",
            f"Donate to `u1`{address[2:]}.",
        ),
        (
            "copied_code_suffix",
            f"Unified addresses end with `{address[-16:]}`.",
            f"Donate to {address[:-16]}`{address[-16:]}`.",
        ),
        (
            "copied_code_middle",
            f"Unified addresses contain `{address[40:48]}`.",
            f"Donate to {address[:40]}`{address[40:48]}`{address[48:]}.",
        ),
        (
            "copied_code_prefix_math_suffix",
            "Unified addresses begin with `u1`.",
            f"Donate to \\(\\text{{u1}}\\){address[2:]}.",
        ),
        (
            "copied_code_prefix_color_math_suffix",
            "Unified addresses begin with `u1`.",
            f"Donate to u1\\(\\color{{red}}{{{address[2:40]}}}\\){address[40:]}.",
        ),
        (
            "adjacent_code_spans_with_empty_link",
            (
                f"Unified addresses begin with `u1` and continue with `{address[2:]}`. "
                "[separator](https://free2z.cash)"
            ),
            f"Donate `u1`[](https://free2z.cash)`{address[2:]}`.",
        ),
        (
            "fenced_code_fragment_joined_in_prose",
            "Unified addresses begin with:\n\n```text\nu1\n```",
            f"Donate to {address}.",
        ),
        (
            "inline_code_reinterpreted_as_table_cells",
            f"Example: `left | {address[:40]}**{address[40:]}**`.",
            (
                "| Example | Value | Extra |\n| --- | --- | --- |\n"
                f"| Donate | `left | {address[:40]}**{address[40:]}**` | x |"
            ),
        ),
        (
            "unchanged_code_address_does_not_authorize_formatted_prose_copy",
            f"Example: `{address}`.",
            (
                f"Ejemplo: `{address}`.\n\nDonate: "
                f"{address[:40]}**{address[40:]}**."
            ),
        ),
    ]
    boundary_outputs = [case[2] for case in boundary_cases]
    boundary_rendered = render(boundary_outputs)
    for (name, source_text, translated), output in zip(
        boundary_cases, boundary_rendered
    ):
        html_text = unescape(re.sub(r"<[^>]*>", "", output["html"]))
        codes = [
            violation.code
            for violation in safety.find_violations(source_text, translated)
        ]
        if address not in html_text:
            failures.append(
                f"boundary case did not render a complete address  {name}: {html_text}"
            )
        if "url_not_in_source" not in codes:
            failures.append(
                f"copied code fragment authorized assembled address  {name}: codes={codes}"
            )

    benign_code_cases = [
        (
            "unchanged_complete_code_address",
            f"Example: `{address}`.",
            f"Ejemplo: `{address}`.",
            True,
        ),
        (
            "unchanged_indented_code_address",
            f"Example:\n\n    {address}",
            f"Ejemplo:\n\n    {address}",
            True,
        ),
        (
            "unchanged_indented_code_literal_emphasis",
            f"Example:\n\n    {address[:40]}**{address[40:]}**",
            f"Ejemplo:\n\n    {address[:40]}**{address[40:]}**",
            False,
        ),
        (
            "unchanged_malformed_code_example",
            f"Example: `{address[:40]}*{address[40:]}`.",
            f"Ejemplo: `{address[:40]}*{address[40:]}`.",
            False,
        ),
        (
            "unchanged_fenced_code_example",
            f"Example:\n\n```markdown\n{address[:40]}**{address[40:]}**\n```",
            f"Ejemplo:\n\n```markdown\n{address[:40]}**{address[40:]}**\n```",
            False,
        ),
        (
            "unchanged_fenced_example_with_inline_backticks",
            f"Example:\n\n```markdown\nDonate `{address}`\n```",
            f"Ejemplo:\n\n```markdown\nDonate `{address}`\n```",
            True,
        ),
        (
            "unchanged_list_fenced_code_example",
            f"Example:\n\n- ```markdown\n  {address[:40]}**{address[40:]}**\n  ```",
            f"Ejemplo:\n\n- ```markdown\n  {address[:40]}**{address[40:]}**\n  ```",
            False,
        ),
    ]
    benign_code_rendered = render([case[2] for case in benign_code_cases])
    for (name, source_text, translated, shows_address), output in zip(
        benign_code_cases, benign_code_rendered
    ):
        html_text = unescape(re.sub(r"<[^>]*>", "", output["html"]))
        codes = [
            violation.code
            for violation in safety.find_violations(source_text, translated)
        ]
        if (address in html_text) != shows_address:
            failures.append(
                f"benign code control rendered unexpectedly  {name}: {html_text}"
            )
        if "url_not_in_source" in codes:
            failures.append(
                f"unchanged code control was fatal  {name}: codes={codes}"
            )

    invalid_sources = [
        (
            "mismatched-source-emphasis",
            address[:40] + "*" + address[40:] + "**x",
        ),
        (
            "inline-code-math-source",
            f"Example: `{address[:40]}"
            + r"\(\text{"
            + address[40:80]
            + r"}\)"
            + f"{address[80:]}`",
        ),
        (
            "indented-code-emphasis-source",
            f"    {address[:40]}**{address[40:]}**",
        ),
        (
            "tab-indented-code-emphasis-source",
            f"\t{address[:40]}**{address[40:]}**",
        ),
        (
            "blockquote-indented-code-authority-source",
            f"> Example:\n>\n>     {address[:40]}**{address[40:]}**",
        ),
        (
            "unknown-math-command-source",
            address[:40] + r"\(\notacommand{"
            + address[40:80] + r"}\)" + address[80:],
        ),
        (
            "unmatched-single-before-double-code-source",
            "A stray ` then ``" + address[:40]
            + r"\(\text{" + address[40:80] + r"}\)"
            + address[80:] + "``.",
        ),
        (
            "blockquote-indented-code-source",
            f">     {address[:40]}**{address[40:]}**",
        ),
    ]
    valid_destination_translation = f"Donate: {address}"
    source_rendered = render([source for _name, source in invalid_sources])
    valid_translation_rendered = render([valid_destination_translation])[0]
    valid_translation_text = unescape(
        re.sub(r"<[^>]*>", "", valid_translation_rendered["html"])
    )
    if address not in valid_translation_text:
        failures.append("the source-authorization control did not render its address")
    for (name, invalid_source), output in zip(invalid_sources, source_rendered):
        invalid_source_text = unescape(
            re.sub(r"<[^>]*>", "", output["html"])
        )
        invalid_source_codes = [
            violation.code
            for violation in safety.find_violations(
                invalid_source,
                invalid_source + "\n\n" + valid_destination_translation,
            )
        ]
        if address in invalid_source_text:
            failures.append(f"{name} unexpectedly rendered an address")
        if "url_not_in_source" not in invalid_source_codes:
            failures.append(
                f"{name} authorized a new payment address: "
                f"codes={invalid_source_codes}"
            )

    math_address_source = (
        address[:40] + r"\(\text{" + address[40:80] + r"}\)" + address[80:]
    )
    math_address_html = render([math_address_source])[0]["html"]
    math_address_text = unescape(re.sub(r"<[^>]*>", "", math_address_html))
    if address not in math_address_text:
        failures.append("unchanged KaTeX payment address did not render contiguously")
    if "url_not_in_source" in {
        violation.code
        for violation in safety.find_violations(
            math_address_source, math_address_source
        )
    }:
        failures.append("unchanged KaTeX payment address was rejected")

    amount_source = f"Donate: zcash:{address}?label=Thanks(creator)&amount=1"
    amount_cases = {
        "markdown_emphasis_in_parameter": (
            f"Donar: zcash:{address}?amou**nt**=100"
        ),
        "entity_in_parameter": (
            f"Donar: zcash:{address}?amou&#110;t=100"
        ),
        "link_label_in_parameter": (
            f"Donar: zcash:{address}?amou[nt](https://free2z.cash)=100"
        ),
        "link_title_backticks_before_amount": (
            "[x](https://free2z.cash \"`\") Donar: "
            + f"zcash:{address}?amou**nt**=100 `end`"
        ),
        "triple_emphasis_inside_amount": (
            f"Donar: zcash:{address}?amou***nt***=100"
        ),
        "single_tilde_strikethrough_inside_amount": (
            f"Donar: zcash:{address}?amou~nt~=100"
        ),
        "parenthesized_label_before_amount": (
            f"Donar: zcash:{address}?label=Gracias(creator)&amount=100"
        ),
        "math_backticks_before_entity_amount": (
            "\\(a`b\\) Donar: "
            + f"zcash:{address}?amou&#110;t=100 \\(c`d\\)"
        ),
        "katex_text_command_inside_amount": (
            f"Donar: zcash:{address}?amou" + r"\(\text{nt}\)=100"
        ),
        "katex_inline_math_inside_amount": (
            f"Donar: zcash:{address}?amou" + r"\(nt\)=100"
        ),
        "katex_color_command_inside_amount": (
            f"Donar: zcash:{address}?amou"
            + r"\(\color{red}{nt}\)=100"
        ),
        "katex_textcolor_command_inside_amount": (
            f"Donar: zcash:{address}?amou"
            + r"\(\textcolor{red}{nt}\)=100"
        ),
        "copied_code_amount_key_boundary": (
            f"Donar: zcash:{address}?`amou`nt=100"
        ),
    }
    rendered_amount_cases = render([amount_source, *amount_cases.values()])[1:]
    for (name, translated), rendered in zip(amount_cases.items(), rendered_amount_cases):
        html_text = unescape(re.sub(r"<[^>]*>", "", rendered["html"]))
        codes = [
            violation.code
            for violation in safety.find_violations(amount_source, translated)
        ]
        if f"{address}?" not in html_text or "amount=100" not in html_text:
            failures.append(f"rendered ZIP-321 amount case changed unexpectedly  {name}: {html_text}")
        if "zip321_amount_not_in_source" not in codes:
            failures.append(f"rendered ZIP-321 amount bypass not fatal  {name}: codes={codes}")

    benign_amount_cases = {
        "emphasized_amount": (
            f"Donar: zcash:{address}?amount=**1**&label=hola"
        ),
        "escaped_parameter_separator": (
            f"Donar: zcash:{address}?amount=1\\&label=hola"
        ),
    }
    benign_amount_source = f"Donate: zcash:{address}?amount=1&label=hello"
    rendered_benign_amounts = render(
        [benign_amount_source, *benign_amount_cases.values()]
    )[1:]
    for (name, translated), rendered in zip(
        benign_amount_cases.items(), rendered_benign_amounts
    ):
        html_text = unescape(re.sub(r"<[^>]*>", "", rendered["html"]))
        codes = [
            violation.code
            for violation in safety.find_violations(
                benign_amount_source, translated
            )
        ]
        if f"{address}?amount=1&label=hola" not in html_text:
            failures.append(f"benign ZIP-321 formatting did not render as expected  {name}: {html_text}")
        if "zip321_amount_not_in_source" in codes:
            failures.append(f"benign ZIP-321 formatting was fatal  {name}: codes={codes}")

    # A raw ZIP-321 token in source code cannot authorize the amount that the
    # renderer exposes when the translation changes its Markdown context. The
    # reference-definition title tick is consumed by Markdown, even though a
    # simple backtick scanner can pair it with the translated URI's trailing
    # tick and mistake the URI for code on both sides.
    code_uri = f"zcash:{address}?amount=1**00**"
    code_amount_prose = f"Donate to {address}.\n\n"
    code_amount_source = code_amount_prose + f"Example: ``{code_uri} ``"
    fenced_code_amount_source = (
        code_amount_prose + f"Example:\n\n```text\n{code_uri}\n```"
    )
    indented_code_amount_source = (
        code_amount_prose + f"Example:\n\n    {code_uri}"
    )
    source_with_reference = (
        code_amount_prose + '[a]: #x "x"\n\n' + f"Example: ``{code_uri} ``"
    )
    source_with_inline_link = (
        code_amount_prose + '[a](#x "x")\n\n' + f"Example: ``{code_uri} ``"
    )
    code_context_cases = {
        "unmatched_closing_tick": (
            code_amount_source,
            code_amount_prose + f"Example: {code_uri} `",
        ),
        "mixed_delimiter_inside_double_code_span": (
            code_amount_source,
            code_amount_prose + f"Example: `` x ` y `` {code_uri} `",
        ),
        "reference_definition_title_tick": (
            source_with_reference,
            code_amount_prose + '[a]: #x "`"\n\n' + f"Example: {code_uri} `",
        ),
        "escaped_reference_definition_title_tick": (
            source_with_reference,
            code_amount_prose + '[a]: #x "\\`"\n\n' + f"Example: {code_uri} `",
        ),
        "nested_parentheses_reference_title": (
            code_amount_prose
            + f"[a]: #x (nested (` {code_uri} `))",
            code_amount_prose + code_uri,
        ),
        "inline_link_title_tick": (
            source_with_inline_link,
            code_amount_prose + '[a](#x "`")\n\n' + f"Example: {code_uri} `",
        ),
        "table_cell_crossing_backticks": (
            code_amount_source,
            code_amount_prose + "| a | b |\n|---|---|\n"
            + f"| `x | {code_uri} | y` |",
        ),
        "blockquote_fence_container_ends": (
            fenced_code_amount_source,
            code_amount_prose + "> ```text\n> example\n\n"
            + f"{code_uri}\n```",
        ),
        "list_continuation_indented_uri": (
            indented_code_amount_source,
            code_amount_prose + "- item\n  continuation\n\n"
            + f"    {code_uri}",
        ),
        "list_lazy_continuation_indented_uri": (
            indented_code_amount_source,
            code_amount_prose + "- item\ncontinuation\n\n"
            + f"    {code_uri}",
        ),
        "cr_only_line_endings_before_list_continuation": (
            indented_code_amount_source,
            "\r".join([
                f"Donate to {address}.", "", "- item", "continuation", "",
                f"    {code_uri}",
            ]),
        ),
        "unicode_whitespace_ends_indented_uri_block": (
            fenced_code_amount_source,
            code_amount_prose + f"    example\n\u0085\n    {code_uri}",
        ),
    }
    code_context_rendered = render([
        text for pair in code_context_cases.values() for text in pair
    ])
    for index, (name, (source_text, translated)) in enumerate(
        code_context_cases.items()
    ):
        source_rendered, translated_rendered = code_context_rendered[index * 2:index * 2 + 2]
        html_text = translated_rendered["html"]
        source_tokens = [
            match.group(0) for match in safety._ZIP321_URI.finditer(source_text)
        ]
        output_tokens = [
            match.group(0) for match in safety._ZIP321_URI.finditer(translated)
        ]
        source_authorized_amounts = safety._zip321_amounts(
            source_text,
            include_rendered_views=True,
            source_authorization=True,
        )
        codes = [
            violation.code
            for violation in safety.find_violations(source_text, translated)
        ]
        if source_authorized_amounts:
            failures.append(
                f"literal source code unexpectedly authorized a ZIP-321 amount {name}: "
                f"{source_authorized_amounts}"
            )
        if source_tokens != output_tokens:
            failures.append(
                f"ZIP-321 code-context control changed the raw URI token {name}"
            )
        if "nested_parentheses" in name:
            if (
                "<p>[a]: #x (nested (<code" not in source_rendered["html"]
                or "**00**" not in source_rendered["html"]
            ):
                failures.append(
                    "nested reference-title source stopped rendering as paragraph/code"
                )
        elif (
            "<code" not in source_rendered["html"]
            or "**00**" not in source_rendered["html"]
        ):
            failures.append("source ZIP-321 code control did not render literally")
        if "1<strong>00</strong>" not in html_text:
            failures.append(
                f"ZIP-321 context case did not render the visible 100 amount {name}: {html_text}"
            )
        if "zip321_amount_not_in_source" not in codes:
            failures.append(
                f"raw ZIP-321 code token authorized a rendered amount {name}: codes={codes}"
            )

    hidden_reference_title_cases = {
        "double_quoted": f'[a]: #x "hidden {code_uri}"',
        "single_quoted": f"[a]: #x 'hidden {code_uri}'",
        "parenthesized": f"[a]: #x (hidden {code_uri})",
        "multiline_lf": f'[a]: #x\n  "hidden {code_uri}"',
        "multiline_cr": f'[a]: #x\r  "hidden {code_uri}"',
        "multiline_crlf": f'[a]: #x\r\n  "hidden {code_uri}"',
        "four_space_multiline_lf": f'[a]: #x\n    "hidden {code_uri}"',
        "eight_space_multiline_lf": f'[a]: #x\n        "hidden {code_uri}"',
        "escaped_open_bracket_label": f'[a\\[b]: #x "hidden {code_uri}"',
        "consecutive_reference_definitions": (
            f'[a]: #x "title"\n[b]: #x "hidden {code_uri}"'
        ),
    }
    hidden_reference_pairs = {
        name: (code_amount_prose + definition, code_amount_prose + code_uri)
        for name, definition in hidden_reference_title_cases.items()
    }
    block_terminator_reference_cases = {
        "atx_heading": ("# Example", f'[a]: #x "hidden {code_uri} "'),
        "indented_atx_heading": (
            "   ### Example", f'[a]: #x "hidden {code_uri} "',
        ),
        "setext_h2": ("Example\n---", f'[a]: #x "hidden {code_uri} "'),
        "setext_h1": ("Example\n===", f'[a]: #x "hidden {code_uri} "'),
        "thematic_break_trailing_tab": (
            "Example\n---\t", f'[a]: #x "hidden {code_uri} "',
        ),
        "thematic_break": ("***", f'[a]: #x "hidden {code_uri} "'),
        "indented_code": (
            "    # Example", f'[a]: #x "hidden {code_uri} "',
        ),
        "fenced_code": (
            "```text\nexample\n```", f'[a]: #x "hidden {code_uri} "',
        ),
        "blockquote_heading": (
            "> # Example", f'> [a]: #x "hidden {code_uri} "',
        ),
        "blockquote_setext": (
            "> Example\n> ---", f'> [a]: #x "hidden {code_uri} "',
        ),
        "blockquote_thematic_break": (
            "> ***", f'> [a]: #x "hidden {code_uri} "',
        ),
        "list_heading": (
            "- # Example", f'  [a]: #x "hidden {code_uri} "',
        ),
        "list_setext": (
            "- Example\n  ---", f'  [a]: #x "hidden {code_uri} "',
        ),
        "list_thematic_break": (
            "- ***", f'  [a]: #x "hidden {code_uri} "',
        ),
    }
    for name, (block, definition) in block_terminator_reference_cases.items():
        hidden_reference_pairs[f"after_{name}"] = (
            code_amount_prose + block + "\n" + definition,
            code_amount_prose.replace("Donate", "Donar") + block + "\n" + code_uri,
        )
    multiline_destination_cases = {
        "lf_destination_one_space": f'[a]:\n #x "hidden {code_uri}"',
        "lf_destination_four_spaces": f'[a]:\n    #x "hidden {code_uri}"',
        "lf_destination_tab_then_title_line": f'[a]:\n\t#x\n "hidden {code_uri}"',
        "lf_multiline_title": f'[a]:\n #x\n "hidden\n{code_uri}\n"',
        "cr_destination": f'[a]:\r #x "hidden {code_uri}"',
        "crlf_destination": f'[a]:\r\n #x "hidden {code_uri}"',
        "blockquote_multiline_destination": (
            f'> [a]:\n> #x "hidden {code_uri}"'
        ),
        "list_multiline_destination": (
            f'- [a]:\n  #x "hidden {code_uri}"'
        ),
    }
    for name, definition in multiline_destination_cases.items():
        hidden_reference_pairs[name] = (
            code_amount_prose + definition,
            code_amount_prose.replace("Donate", "Donar") + code_uri,
        )
    hidden_reference_pairs["blockquote_definition"] = (
        code_amount_prose + f'> [a]: #x "hidden {code_uri}"',
        code_amount_prose.replace("Donate", "Donar") + f'> {code_uri}',
    )
    hidden_reference_pairs["list_definition"] = (
        code_amount_prose + f'- [a]: #x "hidden {code_uri}"',
        code_amount_prose.replace("Donate", "Donar") + f'- {code_uri}',
    )
    for marker in ("2.", "2)", "0.", "0)"):
        hidden_reference_pairs[f"noninterrupting_ordered_list_{marker[0]}_{marker[1]}"] = (
            code_amount_prose + f'[a]: #x "hidden {code_uri}"',
            code_amount_prose.replace("Donate", "Donar").rstrip("\n") + "\n"
            + f'{marker} [a]: #x "hidden {code_uri}"',
        )
    for name, marker in (("arabic_indic", "١."), ("fullwidth", "１.")):
        hidden_reference_pairs[f"unicode_ordered_list_{name}"] = (
            code_amount_prose + f'[a]: #x "hidden {code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'{marker} [a]: #x "hidden {code_uri}"',
        )
    hidden_reference_pairs["blockquote_multiline_title"] = (
        code_amount_prose + f'> [a]: #x\n>   "hidden {code_uri}"',
        code_amount_prose.replace("Donate", "Donar") + f'> {code_uri}',
    )
    hidden_reference_pairs["list_multiline_title"] = (
        code_amount_prose + f'- [a]: #x\n  "hidden {code_uri}"',
        code_amount_prose.replace("Donate", "Donar") + f'- {code_uri}',
    )
    hidden_reference_pairs["blockquote_title_missing_continuation_prefix"] = (
        code_amount_prose + f"> [a]: #x 'hidden {code_uri} '",
        code_amount_prose.replace("Donate", "Donar")
        + f"> [a]: #x 'hidden\n{code_uri} \n'",
    )
    hidden_reference_pairs["blockquote_following_title_missing_prefix"] = (
        code_amount_prose + f'> [a]: #x "hidden {code_uri} "',
        code_amount_prose.replace("Donate", "Donar")
        + f'> [a]: #x\n"hidden {code_uri} "',
    )
    trailing_tab_source = (
        code_amount_prose + f'[a]: #x "hidden {code_uri}"'
    )
    hidden_reference_pairs["trailing_tab_after_title"] = (
        trailing_tab_source,
        trailing_tab_source + "\t",
    )
    missing_separator_source = (
        code_amount_prose + f'[a]: <#x> "hidden {code_uri}"'
    )
    hidden_reference_pairs["missing_space_before_title"] = (
        missing_separator_source,
        missing_separator_source.replace('<#x> "hidden', '<#x>"hidden', 1),
    )
    multiline_fake_definition_source = (
        code_amount_prose
        + f'[a]: #x "outer\n[b]: #x \'inner\n{code_uri}\nend"\n\''
    )
    hidden_reference_pairs["definition_like_text_inside_title"] = (
        multiline_fake_definition_source,
        multiline_fake_definition_source.replace("Donate", "Donar").replace(
            f"{code_uri}\nend\"", f"end\"\n{code_uri}", 1,
        ),
    )
    marked_destination_whitespace = (
        " ", "\t", "\n", "\r", "\v", "\f", "\u00a0", "\u1680",
        *[chr(codepoint) for codepoint in range(0x2000, 0x200B)],
        "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
    )
    for boundary in marked_destination_whitespace:
        name = f"unicode_destination_boundary_u{ord(boundary):04x}"
        hidden_reference_pairs[name] = (
            code_amount_prose + f'[a]: #x "hidden {code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: #x{boundary}junk "hidden {code_uri}"',
        )
        if boundary not in "\r\n":
            hidden_reference_pairs[
                f"whitespace_only_reference_label_u{ord(boundary):04x}"
            ] = (
                code_amount_prose + f'[a]: #x "hidden {code_uri}"',
                code_amount_prose.replace("Donate", "Donar")
                + f'[{boundary}]: #x "hidden {code_uri}"',
            )
    hidden_reference_rendered = render([
        text
        for pair in hidden_reference_pairs.values()
        for text in pair
    ])
    for index, (name, (source_text, translated)) in enumerate(
        hidden_reference_pairs.items()
    ):
        source_rendered, translated_rendered = hidden_reference_rendered[
            index * 2:index * 2 + 2
        ]
        source_auth = safety._zip321_amounts(
            source_text, include_rendered_views=True, source_authorization=True,
        )
        codes = [
            violation.code
            for violation in safety.find_violations(source_text, translated)
        ]
        if code_uri in source_rendered["html"]:
            failures.append(
                f"reference-title URI unexpectedly appeared in rendered source {name}: "
                f"{source_rendered['html']}"
            )
        if "1<strong>00</strong>" not in translated_rendered["html"]:
            failures.append(
                f"reference-title translation did not render visible amount {name}: "
                f"{translated_rendered['html']}"
            )
        if source_auth:
            failures.append(
                f"hidden reference-title URI authorized source payment {name}: {source_auth}"
            )
        if "zip321_amount_not_in_source" not in codes:
            failures.append(
                f"hidden reference-title URI authorized visible payment {name}: {codes}"
            )

    malformed_angle_reference_pair = (
        code_amount_prose
        + f'`[x](#<1)`\n\n[a]: <#x> "hidden {code_uri} "',
        code_amount_prose.replace("Donate", "Donar")
        + f'`[x](#<1)`\n\n[a]: <#<1> "hidden {code_uri} "',
    )
    malformed_angle_rendered = render(list(malformed_angle_reference_pair))
    malformed_angle_codes = [
        violation.code
        for violation in safety.find_violations(*malformed_angle_reference_pair)
    ]
    if any(code_uri in item["html"] for item in malformed_angle_rendered):
        failures.append(
            "malformed angle reference control rendered its payment URI: "
            f"{malformed_angle_rendered}"
        )
    if "zip321_amount_not_in_source" in malformed_angle_codes:
        failures.append(
            "nonvisible malformed angle reference control was rejected: "
            f"{malformed_angle_codes}"
        )

    raw_html_uri = f"zcash:{address}?amount=100"
    raw_html_reference_pairs = {
        "pre_block": (
            code_amount_prose
            + f'<pre>example</pre>\n\n[a]: #x "hidden {raw_html_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'<pre>ejemplo\n\n[a]: #x "hidden {raw_html_uri}"\n\n</pre>',
        ),
        "generic_block_tag": (
            code_amount_prose
            + f'<div>example</div>\n\n[a]: #x "hidden {raw_html_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'<div>ejemplo\n[a]: #x "hidden {raw_html_uri}"\n</div>',
        ),
        "blockquote_pre": (
            code_amount_prose
            + f'> <pre>example</pre>\n\n> [a]: #x "hidden {raw_html_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'> <pre>ejemplo\n> [a]: #x "hidden {raw_html_uri}"\n> </pre>',
        ),
        "list_pre": (
            code_amount_prose
            + f'- <pre>example</pre>\n  [a]: #x "hidden {raw_html_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'- <pre>ejemplo\n  [a]: #x "hidden {raw_html_uri}"\n  </pre>',
        ),
        "custom_element_block": (
            code_amount_prose
            + f'<custom>example</custom>\n\n- [a]: #x "hidden {raw_html_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'<custom>\n- [a]: #x "hidden {raw_html_uri}"\n</custom>',
        ),
        "pre_prefix_custom_element": (
            code_amount_prose
            + f'<pre-example>example</pre-example>\n\n[a]: #x "hidden {raw_html_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'<pre-example>ejemplo</pre-example>\n\n{raw_html_uri}',
        ),
        "malformed_pre_closer": (
            code_amount_prose
            + f'<pre>example</pre>\n\n[a]: #x "hidden {raw_html_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'<pre>ejemplo\n</ pre>\n\n[a]: #x "hidden {raw_html_uri}"',
        ),
    }
    raw_html_reference_rendered = render([
        text
        for pair in raw_html_reference_pairs.values()
        for text in pair
    ])
    for index, (name, pair) in enumerate(raw_html_reference_pairs.items()):
        source_text, translated = pair
        source_rendered, translated_rendered = raw_html_reference_rendered[
            index * 2:index * 2 + 2
        ]
        source_auth = safety._zip321_amounts(
            source_text, include_rendered_views=True, source_authorization=True,
        )
        codes = [
            violation.code for violation in safety.find_violations(*pair)
        ]
        if raw_html_uri in source_rendered["html"]:
            failures.append(f"raw HTML source reference URI was visible: {name}")
        if raw_html_uri not in translated_rendered["html"]:
            failures.append(
                f"raw HTML translation did not display payment amount 100: {name}"
            )
        if source_auth:
            failures.append(
                f"raw HTML source reference title authorized payment: {source_auth}"
            )
        if "zip321_amount_not_in_source" not in codes:
            failures.append(
                f"raw HTML visible payment was not fatal {name}: {codes}"
            )

    fenced_reference_pair = (
        code_amount_prose
        + f'\n\n```text\nexample\n```\n\n[a]: #x "{raw_html_uri}"',
        code_amount_prose.replace("Donate", "Donar")
        + f'\n\n```text\nexample\n\n[a]: #x "{raw_html_uri}"\n```',
    )
    fenced_reference_rendered = render(list(fenced_reference_pair))
    fenced_reference_codes = [
        violation.code
        for violation in safety.find_violations(*fenced_reference_pair)
    ]
    if raw_html_uri in fenced_reference_rendered[0]["html"]:
        failures.append("valid fenced reference-title control exposed a URI")
    if raw_html_uri not in fenced_reference_rendered[1]["html"]:
        failures.append(
            "fenced reference-title translation did not display payment amount: "
            f"{fenced_reference_rendered[1]['html']}"
        )
    if "zip321_amount_not_in_source" not in fenced_reference_codes:
        failures.append(
            "visible fenced reference-title payment was not fatal: "
            f"{fenced_reference_codes}"
        )

    unicode_hidden_controls = {
        "nel_is_not_marked_whitespace": (
            code_amount_prose + f'[a]: #x "hidden {code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: #x\u0085junk "hidden {code_uri}"',
        ),
        "entity_encoded_nbsp_destination": (
            code_amount_prose + f'[a]: #x&#160;junk "hidden {code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: #x&#160;junk "hidden {code_uri}"',
        ),
        "entity_encoded_nbsp_angle_destination": (
            code_amount_prose
            + f'[a]: <#x&#160;junk> "hidden {code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: <#x&#160;junk> "hidden {code_uri}"',
        ),
        "nbsp_reference_label": (
            code_amount_prose + f'[a\u00a0b]: #x "hidden {code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a\u00a0b]: #x "hidden {code_uri}"',
        ),
        "nbsp_reference_title": (
            code_amount_prose + f'[a]: #x "hidden\u00a0{code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: #x "hidden\u00a0{code_uri}"',
        ),
        "nel_reference_title": (
            code_amount_prose + f'[a]: #x "hidden\u0085{code_uri}"',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: #x "hidden\u0085{code_uri}"',
        ),
        "single_quoted_multiline_title": (
            code_amount_prose + f"[a]: #x 'hidden\n{code_uri} '\n",
            code_amount_prose.replace("Donate", "Donar")
            + f"[a]: #x 'hidden\n{code_uri} '\n",
        ),
        "double_quoted_multiline_title": (
            code_amount_prose + f'[a]: #x "hidden\n{code_uri} "\n',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: #x "hidden\n{code_uri} "\n',
        ),
        "parenthesized_multiline_title": (
            code_amount_prose + f'[a]: #x (hidden\n{code_uri} )\n',
            code_amount_prose.replace("Donate", "Donar")
            + f'[a]: #x (hidden\n{code_uri} )\n',
        ),
        "blockquote_single_quoted_multiline_title": (
            code_amount_prose + f"> [a]: #x 'hidden\n> {code_uri} '\n",
            code_amount_prose.replace("Donate", "Donar")
            + f"> [a]: #x 'hidden\n> {code_uri} '\n",
        ),
        "list_single_quoted_multiline_title": (
            code_amount_prose + f"- [a]: #x 'hidden\n  {code_uri} '\n",
            code_amount_prose.replace("Donate", "Donar")
            + f"- [a]: #x 'hidden\n  {code_uri} '\n",
        ),
    }
    unicode_hidden_control_rendered = render([
        text
        for pair in unicode_hidden_controls.values()
        for text in pair
    ])
    for index, (name, pair) in enumerate(unicode_hidden_controls.items()):
        source_rendered, translated_rendered = unicode_hidden_control_rendered[
            index * 2:index * 2 + 2
        ]
        codes = [
            violation.code for violation in safety.find_violations(*pair)
        ]
        if (
            "1<strong>00</strong>" in source_rendered["html"]
            or "1<strong>00</strong>" in translated_rendered["html"]
        ):
            failures.append(
                f"benign Unicode reference control exposed hidden URI {name}"
            )
        if codes:
            failures.append(
                f"faithful Unicode reference control was rejected {name}: {codes}"
            )

    nonvisible_list_pair = (
        code_amount_prose + f"- [a]: #x 'hidden {code_uri} '",
        code_amount_prose.replace("Donate", "Donar")
        + f"- [a]: #x 'hidden\n{code_uri} \n'",
    )
    nonvisible_list_rendered = render(list(nonvisible_list_pair))
    nonvisible_list_codes = [
        violation.code for violation in safety.find_violations(*nonvisible_list_pair)
    ]
    if code_uri in nonvisible_list_rendered[0]["html"]:
        failures.append("valid list reference-title control exposed a URI")
    if "1<strong>00</strong>" in nonvisible_list_rendered[1]["html"]:
        failures.append(
            "missing-indentation list control unexpectedly rendered the amount: "
            f"{nonvisible_list_rendered[1]['html']}"
        )

    for marker in ("1.", "1)", "-", "+", "*"):
        source_text = code_amount_prose + f'[a]: #x "hidden {code_uri}"'
        translated = (
            code_amount_prose.replace("Donate", "Donar").rstrip("\n") + "\n"
            + f'{marker} [a]: #x "hidden {code_uri}"'
        )
        rendered = render([source_text, translated])
        codes = [
            violation.code for violation in safety.find_violations(source_text, translated)
        ]
        if code_uri in rendered[1]["html"]:
            failures.append(
                f"valid interrupting list reference exposed URI for {marker!r}: "
                f"{rendered[1]['html']}"
            )
        if "zip321_amount_not_in_source" in codes:
            failures.append(
                f"valid interrupting list reference was rejected for {marker!r}: {codes}"
            )

    list_padding_cases = [
        (" " * count, count > 4, str(count)) for count in range(1, 7)
    ] + [("\t", False, "tab"), (" \t", True, "space-tab")]
    for padding, is_indented_code, padding_name in list_padding_cases:
        source_text = code_amount_prose + f'[a]: #x "hidden {raw_html_uri} "'
        translated = (
            code_amount_prose.replace("Donate", "Donar")
            + "-" + padding
            + f'[a]: #x "hidden {raw_html_uri} "'
        )
        rendered = render([source_text, translated])
        codes = [
            violation.code for violation in safety.find_violations(source_text, translated)
        ]
        amount_is_visible = raw_html_uri in rendered[1]["html"]
        amount_is_fatal = "zip321_amount_not_in_source" in codes
        if not is_indented_code and (amount_is_visible or amount_is_fatal):
            failures.append(
                f"valid list padding {padding_name} exposed/rejected the hidden title: "
                f"visible={amount_is_visible}, violations={codes}"
            )
        if is_indented_code and (not amount_is_visible or not amount_is_fatal):
            failures.append(
                f"indented code after list padding {padding_name} evaded validation: "
                f"visible={amount_is_visible}, violations={codes}"
            )

    unchanged_hidden_title_uri = f"zcash:{address}?amount=1"
    unchanged_hidden_title_pair = (
        f'Example\n\n[a]: #x "{unchanged_hidden_title_uri}"',
        f'Ejemplo\n\n[a]: #x "{unchanged_hidden_title_uri}"',
    )
    unchanged_hidden_title_rendered = render(list(unchanged_hidden_title_pair))
    unchanged_hidden_title_codes = [
        violation.code
        for violation in safety.find_violations(*unchanged_hidden_title_pair)
    ]
    if any(
        unchanged_hidden_title_uri in item["html"]
        for item in unchanged_hidden_title_rendered
    ):
        failures.append("unchanged reference-title URI became visible in rendered HTML")
    if unchanged_hidden_title_codes:
        failures.append(
            "faithful translation of a hidden reference title was rejected: "
            f"{unchanged_hidden_title_codes}"
        )

    unchanged_block_definition_pairs = [
        (
            code_amount_prose + f"# Example\n[a]: #x \"hidden {code_uri} \"",
            code_amount_prose.replace("Donate", "Donar")
            + f"# Example\n[a]: #x \"hidden {code_uri} \"",
        ),
        (
            code_amount_prose + f"[a]:\n #x \"hidden {code_uri}\"",
            code_amount_prose.replace("Donate", "Donar")
            + f"[a]:\n #x \"hidden {code_uri}\"",
        ),
    ]
    unchanged_block_rendered = render([
        text for pair in unchanged_block_definition_pairs for text in pair
    ])
    for index, pair in enumerate(unchanged_block_definition_pairs):
        source_rendered, translated_rendered = unchanged_block_rendered[
            index * 2:index * 2 + 2
        ]
        codes = [v.code for v in safety.find_violations(*pair)]
        if code_uri in source_rendered["html"] or code_uri in translated_rendered["html"]:
            failures.append(
                f"unchanged hidden block definition became visible: {pair[0]!r}"
            )
        if codes:
            failures.append(
                f"faithful translation of hidden block definition was rejected: {codes}"
            )

    visible_reference_context_pairs = {
        "paragraph_lookalike": (
            code_amount_prose + f'Example\n[a]: #x "visible {code_uri} "',
            code_amount_prose.replace("Donate", "Donar")
            + f'Example\n[a]: #x "visible {code_uri} "',
        ),
        "hash_without_heading_space": (
            code_amount_prose + f'#Not a heading\n[a]: #x "visible {code_uri} "',
            code_amount_prose.replace("Donate", "Donar")
            + f'#Not a heading\n[a]: #x "visible {code_uri} "',
        ),
        "seven_hashes_not_heading": (
            code_amount_prose + f'####### Too many hashes\n[a]: #x "visible {code_uri} "',
            code_amount_prose.replace("Donate", "Donar")
            + f'####### Too many hashes\n[a]: #x "visible {code_uri} "',
        ),
        "invalid_setext_tab": (
            code_amount_prose + f'Example\n---x\n[a]: #x "visible {code_uri} "',
            code_amount_prose.replace("Donate", "Donar")
            + f'Example\n---x\n[a]: #x "visible {code_uri} "',
        ),
        "blockquote_paragraph": (
            code_amount_prose + f'> Example\n> [a]: #x "visible {code_uri} "',
            code_amount_prose.replace("Donate", "Donar")
            + f'> Example\n> [a]: #x "visible {code_uri} "',
        ),
        "list_paragraph": (
            code_amount_prose + f'- Example\n  [a]: #x "visible {code_uri} "',
            code_amount_prose.replace("Donate", "Donar")
            + f'- Example\n  [a]: #x "visible {code_uri} "',
        ),
        "escaped_html": (
            code_amount_prose
            + f'<div>Example</div>\n[a]: #x "visible zcash:{address}?amount=100 "',
            code_amount_prose.replace("Donate", "Donar")
            + f'<div>Example</div>\n[a]: #x "visible zcash:{address}?amount=100 "',
        ),
    }
    visible_reference_rendered = render([
        text
        for pair in visible_reference_context_pairs.values()
        for text in pair
    ])
    for index, (name, pair) in enumerate(visible_reference_context_pairs.items()):
        source_rendered, translated_rendered = visible_reference_rendered[
            index * 2:index * 2 + 2
        ]
        source_text = visible_payment_text(source_rendered["html"])
        if "amount=100" not in source_text:
            failures.append(
                f"visible reference-like source control did not display amount {name}: "
                f"{source_rendered['html']}"
            )
        codes = [v.code for v in safety.find_violations(*pair)]
        if "zip321_amount_not_in_source" in codes:
            failures.append(
                f"faithful visible reference-like control was rejected {name}: {codes}"
            )

    malformed_title_pair = (
        code_amount_prose + f'[a]: #x "hidden {code_uri}"',
        code_amount_prose + f'[a[b]: #x "hidden {code_uri}"',
    )
    malformed_title_rendered = render(list(malformed_title_pair))
    malformed_title_codes = [
        violation.code for violation in safety.find_violations(*malformed_title_pair)
    ]
    if code_uri in malformed_title_rendered[0]["html"]:
        failures.append("valid reference-title control rendered its URI visibly")
    if "1<strong>00</strong>" not in malformed_title_rendered[1]["html"]:
        failures.append(
            "malformed reference-title control did not render amount 100 visibly: "
            f"{malformed_title_rendered[1]['html']}"
        )
    if "zip321_amount_not_in_source" not in malformed_title_codes:
        failures.append(
            "malformed visible reference-title amount was not fatal: "
            f"{malformed_title_codes}"
        )

    malformed_predecessor_pair = (
        code_amount_prose + f'[b]: #x junk\n\n[a]: #x "hidden {code_uri}"',
        code_amount_prose + f'[b]: #x junk\n[a]: #x "hidden {code_uri}"',
    )
    malformed_predecessor_rendered = render(list(malformed_predecessor_pair))
    malformed_predecessor_codes = [
        violation.code
        for violation in safety.find_violations(*malformed_predecessor_pair)
    ]
    if code_uri in malformed_predecessor_rendered[0]["html"]:
        failures.append("valid title after malformed predecessor was visible in source")
    if "1<strong>00</strong>" not in malformed_predecessor_rendered[1]["html"]:
        failures.append(
            "malformed-predecessor translation did not render amount visibly: "
            f"{malformed_predecessor_rendered[1]['html']}"
        )
    if "zip321_amount_not_in_source" not in malformed_predecessor_codes:
        failures.append(
            "malformed predecessor authorized a visible ZIP-321 amount: "
            f"{malformed_predecessor_codes}"
        )

    tab_separated_title_pair = (
        code_amount_prose + f'[a]: #x "hidden {code_uri}"',
        code_amount_prose + f'[a]: #x\t"hidden {code_uri}"',
    )
    tab_separated_title_rendered = render(list(tab_separated_title_pair))
    tab_separated_title_codes = [
        violation.code
        for violation in safety.find_violations(*tab_separated_title_pair)
    ]
    if code_uri in tab_separated_title_rendered[0]["html"]:
        failures.append("space-separated reference title control was visible")
    if "1<strong>00</strong>" not in tab_separated_title_rendered[1]["html"]:
        failures.append(
            "tab-separated reference title did not render amount visibly: "
            f"{tab_separated_title_rendered[1]['html']}"
        )
    if "zip321_amount_not_in_source" not in tab_separated_title_codes:
        failures.append(
            "tab-separated visible reference-title amount was not fatal: "
            f"{tab_separated_title_codes}"
        )

    tab_after_label_pair = (
        code_amount_prose + f'[a]: #x "hidden {code_uri}"',
        code_amount_prose + f'[a]:\t#x "hidden {code_uri}"',
    )
    tab_after_label_rendered = render(list(tab_after_label_pair))
    tab_after_label_codes = [
        violation.code for violation in safety.find_violations(*tab_after_label_pair)
    ]
    if code_uri in tab_after_label_rendered[0]["html"]:
        failures.append("valid reference-title control before colon-tab was visible")
    if "1<strong>00</strong>" not in tab_after_label_rendered[1]["html"]:
        failures.append(
            "colon-tab reference definition did not render amount visibly: "
            f"{tab_after_label_rendered[1]['html']}"
        )
    if "zip321_amount_not_in_source" not in tab_after_label_codes:
        failures.append(
            "colon-tab visible reference-title amount was not fatal: "
            f"{tab_after_label_codes}"
        )

    escaped_title_pairs = {
        "single_quoted_escaped_apostrophe": (
            f"[a]: #x 'hidden {code_uri}'",
            f"[a]: #x 'hidden \\' {code_uri}'",
        ),
        "parenthesized_escaped_close": (
            f"[a]: #x (hidden {code_uri})",
            f"[a]: #x (hidden \\) {code_uri})",
        ),
        "parenthesized_escaped_open": (
            f"[a]: #x (hidden {code_uri})",
            f"[a]: #x (hidden \\( {code_uri})",
        ),
    }
    escaped_title_pairs = {
        name: (code_amount_prose + source, code_amount_prose + translated)
        for name, (source, translated) in escaped_title_pairs.items()
    }
    escaped_title_rendered = render([
        text for pair in escaped_title_pairs.values() for text in pair
    ])
    for index, (name, (source_text, translated)) in enumerate(
        escaped_title_pairs.items()
    ):
        source_rendered, translated_rendered = escaped_title_rendered[
            index * 2:index * 2 + 2
        ]
        codes = [
            violation.code
            for violation in safety.find_violations(source_text, translated)
        ]
        if code_uri in source_rendered["html"]:
            failures.append(f"valid title was visible in escaped-delimiter control {name}")
        if "1<strong>00</strong>" not in translated_rendered["html"]:
            failures.append(
                f"escaped title delimiter did not expose amount in {name}: "
                f"{translated_rendered['html']}"
            )
        if "zip321_amount_not_in_source" not in codes:
            failures.append(
                f"escaped title delimiter authorized a visible amount in {name}: {codes}"
            )

    pseudo_reference_source = (
        f'Intro\n[a]: #x "` {code_uri} `"'
    )
    pseudo_reference_translation = (
        f'Ejemplo\n[a]: #x "title"\n\n` {code_uri} `\n\n'
        f"zcash:{address}?amount=100"
    )
    pseudo_reference_rendered = render([
        pseudo_reference_source, pseudo_reference_translation,
    ])
    pseudo_reference_amounts = safety._zip321_amounts(
        pseudo_reference_source,
        include_rendered_views=True,
        source_authorization=True,
    )
    pseudo_reference_codes = [
        violation.code
        for violation in safety.find_violations(
            pseudo_reference_source, pseudo_reference_translation,
        )
    ]
    if pseudo_reference_amounts:
        failures.append(
            "paragraph text after a reference-like line authorized ZIP-321 source amount: "
            f"{pseudo_reference_amounts}"
        )
    if (
        "<code" not in pseudo_reference_rendered[0]["html"]
        or "amount=1**00**" not in pseudo_reference_rendered[0]["html"]
    ):
        failures.append("reference-like source paragraph did not render its URI as inline code")
    if "amount=100" not in pseudo_reference_rendered[1]["html"]:
        failures.append("reference-like translated payment did not render visibly")
    if "zip321_amount_not_in_source" not in pseudo_reference_codes:
        failures.append(
            "paragraph text after a reference-like line authorized an amount: "
            f"codes={pseudo_reference_codes}"
        )

    benign_code_amount_cases = {
        "inline": (
            code_amount_source,
            code_amount_prose + f"Ejemplo: ``{code_uri} ``",
        ),
        "fenced": (
            code_amount_prose + f"Example:\n\n```text\n{code_uri}\n```",
            code_amount_prose + f"Ejemplo:\n\n```text\n{code_uri}\n```",
        ),
        "indented": (
            code_amount_prose + f"Example:\n\n    {code_uri}",
            code_amount_prose + f"Ejemplo:\n\n    {code_uri}",
        ),
        "fenced_with_unrelated_html_like_line": (
            code_amount_prose + f"Example:\n\n```text\n{code_uri}\n```\n\n<div>\nplaceholder\n</div>",
            code_amount_prose + f"Ejemplo:\n\n```text\n{code_uri}\n```\n\n<div>\nplaceholder\n</div>",
        ),
    }
    benign_code_amount_rendered = render([
        text for pair in benign_code_amount_cases.values() for text in pair
    ])
    for index, (name, (source_text, translated)) in enumerate(
        benign_code_amount_cases.items()
    ):
        source_output, translated_output = benign_code_amount_rendered[index * 2:index * 2 + 2]
        source_tokens = [
            match.group(0) for match in safety._ZIP321_URI.finditer(source_text)
        ]
        translated_tokens = [
            match.group(0) for match in safety._ZIP321_URI.finditer(translated)
        ]
        codes = [
            violation.code
            for violation in safety.find_violations(source_text, translated)
        ]
        if source_tokens != translated_tokens:
            failures.append(f"benign code amount URI changed in translation {name}")
        if (
            "zcash:" not in source_output["html"]
            or "zcash:" not in translated_output["html"]
        ):
            failures.append(f"benign code amount example did not render {name}")
        if "zip321_amount_not_in_source" in codes:
            failures.append(f"unchanged code amount example was fatal {name}: {codes}")

    invalid_amounts = {
        "underscore": "1_00",
        "unmatched_asterisk": "1*00",
        "unmatched_strikethrough": "1~~00",
        "trailing_underscore": "100_",
        "trailing_asterisk": "100*",
        "invalid_percent_encoding_in_label": "100&label=%ZZ",
        "unescaped_equals_in_label": "100&label=x=y",
        "invalid_base64url_memo": "100&memo=%%%ZZ",
    }
    invalid_amount_sources = [
        f"Donate: zcash:{address}?amount={amount}"
        for amount in invalid_amounts.values()
    ]
    valid_amount_translation = f"Donar: zcash:{address}?amount=100"
    rendered_invalid_amounts = render(
        invalid_amount_sources + [valid_amount_translation] * len(invalid_amount_sources)
    )
    for (name, amount), invalid_source, rendered_source, rendered_translation in zip(
        invalid_amounts.items(),
        invalid_amount_sources,
        rendered_invalid_amounts[:len(invalid_amount_sources)],
        rendered_invalid_amounts[len(invalid_amount_sources):],
    ):
        source_html = rendered_source["html"].replace("&amp;", "&")
        translation_html = rendered_translation["html"].replace("&amp;", "&")
        source_rendered = f"?amount={amount}" in source_html
        if not source_rendered or f"{address}?amount=100" not in translation_html:
            failures.append(f"invalid ZIP-321 source renderer case changed unexpectedly: {name}")
        codes = [
            violation.code
            for violation in safety.find_violations(
                invalid_source, valid_amount_translation
            )
        ]
        if "zip321_amount_not_in_source" not in codes:
            failures.append(
                f"invalid source ZIP-321 amount authorized a valid request ({name}): codes={codes}"
            )

    regressions = zcash_fixture["regressions"]
    regression_renderings = render([
        text for case in regressions for text in (case["source"], case["translated"])
    ])
    for index, case in enumerate(regressions):
        for side, rendering in zip(("source", "output"), regression_renderings[2 * index:2 * index + 2]):
            visible = visible_payment_text(rendering["html"])
            expected = case.get(f"visible_{side}_contains")
            absent = case.get(f"visible_{side}_excludes")
            if expected and expected not in visible:
                failures.append(f"regression {case['name']} {side} lacks expected visible text: {visible}")
            if absent and absent in visible:
                failures.append(f"regression {case['name']} {side} unexpectedly displays protected text: {visible}")
        codes = {v.code for v in safety.find_violations(case["source"], case["translated"])}
        expected = case["expected_code"]
        if expected and expected not in codes:
            failures.append(f"regression {case['name']} lacks {expected}: {codes}")
        if not expected and codes & {"url_not_in_source", "zip321_amount_not_in_source", "payment_math_not_verified", "payment_scan_limit"}:
            failures.append(f"faithful regression {case['name']} rejected: {codes}")

    print(
        f"{len(cases)} URL bypass cases, {len(benign)} benign, "
        f"{len(zcash_fixture['cases'])} rendered payment-address bypass cases, "
        f"{len(boundary_cases)} copied-code boundary cases, "
        f"{len(benign_code_cases)} benign unchanged-code controls, "
        "1 malformed-source authorization control, "
        f"{len(amount_cases)} rendered ZIP-321 amount bypass cases and "
        f"{len(benign_amount_cases)} benign ZIP-321 format cases plus the "
        f"{len(code_context_cases)} rendered ZIP-321 code-context bypass cases and "
        f"{len(hidden_reference_pairs)} hidden reference-title authority cases, "
        f"1 nonvisible malformed-list renderer control "
        f"(safety codes: {nonvisible_list_codes}), "
        f"{len(raw_html_reference_pairs)} raw HTML reference-title cases, "
        "1 fenced-code reference-title movement regression, "
        "1 reference-like paragraph context case, "
        f"{len(benign_code_amount_cases)} benign code-URI examples, "
        f"{len(invalid_amounts)} invalid-source authorization checks; "
        f"{len(regressions)} renderer context regressions; "
        f"{new_host_count} rendered a link to a host not in the source"
    )
    for line in failures:
        print("FAIL", line)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
