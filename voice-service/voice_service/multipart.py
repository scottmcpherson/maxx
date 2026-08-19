"""Small bounded multipart/form-data parser for the OpenAI STT route."""

from __future__ import annotations

import re
from typing import Dict


class MultipartError(ValueError):
    pass


_BOUNDARY_RE = re.compile(r"(?:^|;)\s*boundary=(?:\"([^\"]+)\"|([^;\s]+))", re.IGNORECASE)
_DISPOSITION_RE = re.compile(r'^form-data\s*;\s*name="([^"]+)"(?:\s*;\s*filename="([^"]*)")?\s*$', re.IGNORECASE)
MAX_PART_HEADER_BYTES = 8_192


def parse_multipart(content_type: str, body: bytes) -> Dict[str, bytes]:
    """Parse one bounded multipart request into UTF-8 fields and file bytes.

    Values are returned as bytes so the caller can apply field-specific
    decoding and limits. Filenames are intentionally ignored: the server does
    not persist uploaded audio.
    """

    if not isinstance(content_type, str) or content_type.split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise MultipartError("Content-Type must be multipart/form-data")
    match = _BOUNDARY_RE.search(content_type)
    if not match:
        raise MultipartError("multipart boundary is required")
    try:
        boundary = (match.group(1) or match.group(2)).encode("ascii", "strict")
    except UnicodeEncodeError as exc:
        raise MultipartError("multipart boundary must be ASCII") from exc
    if not 1 <= len(boundary) <= 200 or any(byte < 0x20 or byte > 0x7E for byte in boundary):
        raise MultipartError("multipart boundary is invalid")
    marker = b"--" + boundary
    if not body.startswith(marker):
        raise MultipartError("multipart body does not start with its boundary")

    fields: Dict[str, bytes] = {}
    parts = body.split(marker)
    saw_final = False
    for index, raw in enumerate(parts[1:], start=1):
        if raw.startswith(b"--"):
            saw_final = True
            if raw not in (b"--", b"--\r\n") or index != len(parts) - 1:
                raise MultipartError("malformed multipart terminator")
            break
        if not raw.startswith(b"\r\n"):
            raise MultipartError("malformed multipart part")
        raw = raw[2:]
        separator = raw.find(b"\r\n\r\n")
        if separator < 0 or separator > MAX_PART_HEADER_BYTES:
            raise MultipartError("multipart part headers are malformed or too large")
        header_bytes = raw[:separator]
        value = raw[separator + 4 :]
        if value.endswith(b"\r\n"):
            value = value[:-2]
        try:
            header_lines = header_bytes.decode("ascii").split("\r\n")
        except UnicodeDecodeError as exc:
            raise MultipartError("multipart headers must be ASCII") from exc
        headers = {}
        for line in header_lines:
            if ":" not in line:
                raise MultipartError("malformed multipart header")
            name, header_value = line.split(":", 1)
            name = name.strip().lower()
            if name in headers or not name:
                raise MultipartError("duplicate or empty multipart header")
            headers[name] = header_value.strip()
        disposition = headers.get("content-disposition")
        if disposition is None:
            raise MultipartError("multipart part is missing Content-Disposition")
        disposition_match = _DISPOSITION_RE.match(disposition)
        if not disposition_match:
            raise MultipartError("multipart Content-Disposition is invalid")
        field_name = disposition_match.group(1)
        if field_name in fields:
            raise MultipartError("duplicate multipart field: %s" % field_name)
        fields[field_name] = value
    if not saw_final:
        raise MultipartError("multipart final boundary is missing")
    return fields
