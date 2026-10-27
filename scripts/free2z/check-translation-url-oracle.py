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
        f"{len(invalid_amounts)} invalid-source authorization checks; "
        f"{len(regressions)} renderer context regressions; "
        f"{new_host_count} rendered a link to a host not in the source"
    )
    for line in failures:
        print("FAIL", line)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
