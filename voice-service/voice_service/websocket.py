"""Bounded RFC 6455 framing used by the streaming STT endpoint."""

from __future__ import annotations

import struct
from typing import BinaryIO, Tuple


MAX_WS_FRAME_BYTES = 64 * 1024


class WebSocketProtocolError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _read_exact(stream: BinaryIO, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        data = stream.read(length - len(chunks))
        if not data:
            raise EOFError
        chunks.extend(data)
    return bytes(chunks)


_VALID_CLOSE_CODES = {
    1000,
    1001,
    1002,
    1003,
    1007,
    1008,
    1009,
    1010,
    1011,
}


def _validate_close_payload(payload: bytes) -> None:
    if len(payload) == 0:
        return
    if len(payload) == 1:
        raise WebSocketProtocolError(1002, "invalid close frame")
    code = struct.unpack("!H", payload[:2])[0]
    if code not in _VALID_CLOSE_CODES and not 3000 <= code <= 4999:
        raise WebSocketProtocolError(1002, "invalid WebSocket close code")
    try:
        payload[2:].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WebSocketProtocolError(1007, "WebSocket close reason is not UTF-8") from exc


def read_frame(stream: BinaryIO, max_payload: int = MAX_WS_FRAME_BYTES) -> Tuple[bool, int, bytes]:
    """Read one client frame and enforce mandatory client masking."""

    try:
        first, second = _read_exact(stream, 2)
    except EOFError:
        raise
    fin = bool(first & 0x80)
    if first & 0x70:
        raise WebSocketProtocolError(1002, "reserved WebSocket bits are not supported")
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if not masked:
        raise WebSocketProtocolError(1002, "client WebSocket frames must be masked")
    if length == 126:
        length = struct.unpack("!H", _read_exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read_exact(stream, 8))[0]
        if length & (1 << 63):
            raise WebSocketProtocolError(1002, "invalid WebSocket payload length")
    if length > max_payload:
        raise WebSocketProtocolError(1009, "WebSocket frame exceeds the size limit")
    if opcode >= 8:
        if not fin or length > 125:
            raise WebSocketProtocolError(1002, "invalid WebSocket control frame")
        if opcode not in (8, 9, 10):
            raise WebSocketProtocolError(1002, "unsupported WebSocket control frame")
    if opcode == 0:
        raise WebSocketProtocolError(1002, "fragmented WebSocket messages are not supported")
    mask = _read_exact(stream, 4)
    payload = bytearray(_read_exact(stream, length))
    for index in range(length):
        payload[index] ^= mask[index % 4]
    result = bytes(payload)
    if opcode == 8:
        _validate_close_payload(result)
    return fin, opcode, result


def write_frame(stream: BinaryIO, opcode: int, payload: bytes = b"") -> None:
    """Write one unmasked server frame."""

    if opcode >= 8 and len(payload) > 125:
        raise WebSocketProtocolError(1002, "control payload is too large")
    if len(payload) > MAX_WS_FRAME_BYTES:
        raise WebSocketProtocolError(1009, "WebSocket frame exceeds the size limit")
    first = 0x80 | (opcode & 0x0F)
    length = len(payload)
    if length < 126:
        header = bytes((first, length))
    elif length <= 0xFFFF:
        header = bytes((first, 126)) + struct.pack("!H", length)
    else:
        header = bytes((first, 127)) + struct.pack("!Q", length)
    stream.write(header + payload)
    stream.flush()
