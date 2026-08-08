#!/usr/bin/env python3
"""Fail-closed verification for the packaged ZUULI Info.plist."""

from __future__ import annotations

from collections import Counter
import plistlib
from pathlib import Path
import sys
import xml.etree.ElementTree as ElementTree


TARGET_KEY = "ITSAppUsesNonExemptEncryption"


class VerificationError(Exception):
    pass


def _sized_count(data: bytes, position: int, short_count: int) -> tuple[int, int]:
    if short_count < 0xF:
        return short_count, position
    if position >= len(data):
        raise VerificationError("binary Info.plist has a truncated count")
    marker = data[position]
    if marker >> 4 != 0x1:
        raise VerificationError("binary Info.plist uses an invalid count object")
    byte_count = 1 << (marker & 0xF)
    end = position + 1 + byte_count
    if end > len(data):
        raise VerificationError("binary Info.plist has a truncated count object")
    return int.from_bytes(data[position + 1 : end], "big"), end


def _binary_layout(data: bytes) -> tuple[list[int], int, int, int]:
    if len(data) < 40 or not data.startswith(b"bplist00"):
        raise VerificationError("Info.plist is not a supported binary plist")
    trailer = data[-32:]
    offset_size = trailer[6]
    reference_size = trailer[7]
    object_count = int.from_bytes(trailer[8:16], "big")
    root_reference = int.from_bytes(trailer[16:24], "big")
    offset_table = int.from_bytes(trailer[24:32], "big")
    if (
        offset_size < 1
        or reference_size < 1
        or object_count < 1
        or root_reference >= object_count
        or offset_table < 8
        or offset_table + object_count * offset_size > len(data) - 32
    ):
        raise VerificationError("binary Info.plist trailer is invalid")
    offsets = [
        int.from_bytes(
            data[
                offset_table + index * offset_size :
                offset_table + (index + 1) * offset_size
            ],
            "big",
        )
        for index in range(object_count)
    ]
    if any(offset < 8 or offset >= offset_table for offset in offsets):
        raise VerificationError("binary Info.plist object offset is invalid")
    return offsets, root_reference, reference_size, offset_table


def _binary_string(
    data: bytes, offsets: list[int], reference: int, object_table_end: int
) -> str:
    if reference >= len(offsets):
        raise VerificationError("binary Info.plist key reference is invalid")
    position = offsets[reference]
    marker = data[position]
    kind = marker >> 4
    count, payload = _sized_count(data, position + 1, marker & 0xF)
    if kind == 0x5:
        end = payload + count
        encoding = "ascii"
    elif kind == 0x6:
        end = payload + count * 2
        encoding = "utf-16-be"
    else:
        raise VerificationError("binary Info.plist dictionary key is not a string")
    if end > object_table_end:
        raise VerificationError("binary Info.plist string is truncated")
    try:
        return data[payload:end].decode(encoding)
    except UnicodeDecodeError as error:
        raise VerificationError("binary Info.plist key is not decodable") from error


def _binary_root_keys(data: bytes) -> tuple[list[str], int, int]:
    offsets, root_reference, reference_size, offset_table = _binary_layout(data)
    position = offsets[root_reference]
    marker = data[position]
    if marker >> 4 != 0xD:
        raise VerificationError("binary Info.plist root is not a dictionary")
    count, references = _sized_count(data, position + 1, marker & 0xF)
    references_end = references + count * reference_size * 2
    if references_end > offset_table:
        raise VerificationError("binary Info.plist dictionary is truncated")
    key_references = [
        int.from_bytes(
            data[
                references + index * reference_size :
                references + (index + 1) * reference_size
            ],
            "big",
        )
        for index in range(count)
    ]
    return (
        [
            _binary_string(data, offsets, reference, offset_table)
            for reference in key_references
        ],
        references,
        reference_size,
    )


def _xml_root_keys(data: bytes) -> list[str]:
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError as error:
        raise VerificationError("XML Info.plist is malformed") from error
    if root.tag != "plist" or len(root) != 1 or root[0].tag != "dict":
        raise VerificationError("XML Info.plist root is not a dictionary")
    entries = list(root[0])
    if len(entries) % 2:
        raise VerificationError("XML Info.plist dictionary has an unmatched key")
    keys = []
    for index in range(0, len(entries), 2):
        if entries[index].tag != "key":
            raise VerificationError("XML Info.plist dictionary key is malformed")
        keys.append(entries[index].text or "")
    return keys


def verify_bytes(data: bytes) -> None:
    if data.startswith(b"bplist00"):
        keys, _, _ = _binary_root_keys(data)
    elif data.lstrip().startswith((b"<?xml", b"<plist")):
        keys = _xml_root_keys(data)
    else:
        raise VerificationError("Info.plist must use XML or binary plist format")

    duplicates = sorted(key for key, count in Counter(keys).items() if count > 1)
    if duplicates:
        raise VerificationError(
            "Info.plist root dictionary contains duplicate keys: "
            + ", ".join(duplicates)
        )
    target_count = keys.count(TARGET_KEY)
    if target_count != 1:
        raise VerificationError(
            f"Info.plist must contain exactly one raw {TARGET_KEY} key, found {target_count}"
        )

    try:
        parsed = plistlib.loads(data)
    except (plistlib.InvalidFileException, ValueError) as error:
        raise VerificationError("Info.plist cannot be decoded semantically") from error
    if not isinstance(parsed, dict):
        raise VerificationError("Info.plist root is not a decoded dictionary")
    value = parsed.get(TARGET_KEY)
    if type(value) is not bool:
        raise VerificationError(f"Info.plist {TARGET_KEY} must be a Boolean")
    if value is not False:
        raise VerificationError(f"Info.plist must declare {TARGET_KEY}=false")


def _duplicate_binary_fixture(first_value: bool, second_value: bool) -> bytes:
    data = bytearray(
        plistlib.dumps(
            {TARGET_KEY: first_value, "ZUULIDuplicateFixture": second_value},
            fmt=plistlib.FMT_BINARY,
            sort_keys=False,
        )
    )
    keys, references, reference_size = _binary_root_keys(bytes(data))
    if keys != [TARGET_KEY, "ZUULIDuplicateFixture"]:
        raise AssertionError("binary duplicate fixture has unexpected key order")
    first = data[references : references + reference_size]
    data[references + reference_size : references + reference_size * 2] = first
    return bytes(data)


def _expect_rejected(data: bytes, reason: str, label: str) -> None:
    try:
        verify_bytes(data)
    except VerificationError as error:
        if reason not in str(error):
            raise AssertionError(f"{label} failed for the wrong reason: {error}") from error
    else:
        raise AssertionError(f"{label} unexpectedly passed")


def self_test() -> None:
    valid = {TARGET_KEY: False, "CFBundleIdentifier": "cash.free2z.zuuli"}
    verify_bytes(plistlib.dumps(valid, fmt=plistlib.FMT_XML, sort_keys=False))
    verify_bytes(plistlib.dumps(valid, fmt=plistlib.FMT_BINARY, sort_keys=False))

    same_xml = (
        b'<plist version="1.0"><dict><key>'
        + TARGET_KEY.encode()
        + b"</key><false/><key>"
        + TARGET_KEY.encode()
        + b"</key><false/></dict></plist>"
    )
    conflicting_xml = same_xml.replace(b"<false/>", b"<true/>", 1)
    _expect_rejected(same_xml, "duplicate keys", "same-value XML duplicate")
    _expect_rejected(conflicting_xml, "duplicate keys", "conflicting XML duplicate")

    same_binary = _duplicate_binary_fixture(False, False)
    conflicting_binary = _duplicate_binary_fixture(True, False)
    if plistlib.loads(conflicting_binary).get(TARGET_KEY) is not False:
        raise AssertionError("binary conflict fixture does not demonstrate last-value masking")
    _expect_rejected(same_binary, "duplicate keys", "same-value binary duplicate")
    _expect_rejected(
        conflicting_binary, "duplicate keys", "conflicting binary duplicate"
    )


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if len(sys.argv) != 2:
        print("usage: verify-ios-info-plist.py <Info.plist>", file=sys.stderr)
        return 64
    try:
        verify_bytes(Path(sys.argv[1]).read_bytes())
    except (OSError, VerificationError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
