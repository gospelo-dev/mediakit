"""A local, authenticated WebSocket bridge to a Premiere UXP plugin.

Premiere's UXP runtime can initiate WebSocket connections, but it cannot host
one.  The Python MCP server is therefore the WebSocket *server* and the UXP
panel is its single client.  This module deliberately permits only the small,
read-only RPC surface that the bundled panel understands.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hmac
import json
import os
from pathlib import Path
import secrets
import ssl
from typing import Any, Protocol

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed


class PremiereBridgeError(RuntimeError):
    """Base error for communication with the local Premiere UXP panel."""


class PremiereBridgeNotConnected(PremiereBridgeError):
    """Raised when Premiere has not connected its UXP panel in time."""


class PremiereBridgeProtocolError(PremiereBridgeError):
    """Raised when the UXP panel sends an invalid bridge message."""


class _Connection(Protocol):
    async def send(self, message: str) -> None: ...

    async def close(self, code: int = 1000, reason: str = "") -> None: ...


@dataclass(frozen=True, slots=True)
class BridgeConfig:
    """Configuration for the loopback TLS server.

    ``token`` must be supplied to both the MCP server and the UXP panel.  It
    prevents another local process from issuing Premiere commands.
    """

    host: str
    port: int
    token: str
    certificate_path: Path
    private_key_path: Path

    @classmethod
    def from_environment(cls) -> "BridgeConfig":
        """Read bridge configuration without starting a listening socket."""
        host = os.environ.get("GOSPELO_PREMIERE_BRIDGE_HOST", "127.0.0.1")
        if host not in {"127.0.0.1", "::1", "localhost"}:
            raise PremiereBridgeError(
                "GOSPELO_PREMIERE_BRIDGE_HOST must be a loopback address "
                "(127.0.0.1, ::1, or localhost)."
            )

        try:
            port = int(os.environ.get("GOSPELO_PREMIERE_BRIDGE_PORT", "47653"))
        except ValueError as exc:
            raise PremiereBridgeError("GOSPELO_PREMIERE_BRIDGE_PORT must be an integer.") from exc
        if not 1 <= port <= 65535:
            raise PremiereBridgeError("GOSPELO_PREMIERE_BRIDGE_PORT must be between 1 and 65535.")

        token = os.environ.get("GOSPELO_PREMIERE_BRIDGE_TOKEN", "")
        if len(token) < 32:
            raise PremiereBridgeError(
                "Set GOSPELO_PREMIERE_BRIDGE_TOKEN to a random value of at least 32 characters."
            )

        certificate = os.environ.get("GOSPELO_PREMIERE_BRIDGE_CERT", "")
        private_key = os.environ.get("GOSPELO_PREMIERE_BRIDGE_KEY", "")
        if not certificate or not private_key:
            raise PremiereBridgeError(
                "Set GOSPELO_PREMIERE_BRIDGE_CERT and GOSPELO_PREMIERE_BRIDGE_KEY "
                "to the TLS certificate and private key paths."
            )

        config = cls(
            host=host,
            port=port,
            token=token,
            certificate_path=Path(certificate).expanduser(),
            private_key_path=Path(private_key).expanduser(),
        )
        config.validate_files()
        return config

    def validate_files(self) -> None:
        """Check certificate material before opening a network listener."""
        if not self.certificate_path.is_file():
            raise PremiereBridgeError(f"TLS certificate not found: {self.certificate_path}")
        if not self.private_key_path.is_file():
            raise PremiereBridgeError(f"TLS private key not found: {self.private_key_path}")


class PremiereBridge:
    """Serve one authenticated Premiere UXP client and relay typed requests."""

    _ALLOWED_METHODS = frozenset(
        {
            "project.assets.list",
            "sequence.getState",
            "program.exportFrame",
            "project.create",
            "sequence.insertClip",
            "sequence.addMarker",
            "sequence.importCaptions",
            "sequence.insertMogrt",
        }
    )

    def __init__(self, config: BridgeConfig) -> None:
        self._config = config
        self._server: Server | object | None = None
        self._client: _Connection | None = None
        self._connected = asyncio.Event()
        self._server_lock = asyncio.Lock()
        self._client_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}

    @property
    def endpoint(self) -> str:
        """The fixed endpoint declared in the UXP manifest."""
        return f"wss://{self._config.host}:{self._config.port}"

    @property
    def is_connected(self) -> bool:
        """Whether an authenticated UXP panel is currently attached."""
        return self._connected.is_set()

    async def start(self) -> None:
        """Start the TLS WebSocket listener once, on demand."""
        async with self._server_lock:
            if self._server is not None:
                return

            self._config.validate_files()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(self._config.certificate_path, self._config.private_key_path)
            self._server = await serve(
                self._handle_connection,
                self._config.host,
                self._config.port,
                ssl=context,
                max_size=2 * 1024 * 1024,
            )

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout_seconds: float = 20.0,
    ) -> dict[str, Any]:
        """Send one supported request to Premiere and await its response."""
        if method not in self._ALLOWED_METHODS:
            raise PremiereBridgeProtocolError(f"Unsupported Premiere bridge method: {method}")
        if not 0 < timeout_seconds <= 60:
            raise PremiereBridgeError("timeout_seconds must be greater than 0 and no more than 60.")

        await self.start()
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=timeout_seconds)
        except TimeoutError as exc:
            raise PremiereBridgeNotConnected(
                "Premiere UXP panel is not connected. Open the 'Gospelo Premiere Bridge' panel, "
                "enter the bridge token, and press Connect."
            ) from exc

        request_id = secrets.token_urlsafe(18)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        async with self._client_lock:
            client = self._client
            if client is None:
                raise PremiereBridgeNotConnected("Premiere UXP panel disconnected before the request.")
            self._pending[request_id] = future
            try:
                await client.send(
                    json.dumps(
                        {
                            "type": "request",
                            "id": request_id,
                            "method": method,
                            "params": params,
                        },
                        separators=(",", ":"),
                    )
                )
            except Exception as exc:
                self._pending.pop(request_id, None)
                raise PremiereBridgeNotConnected("Could not send a request to the Premiere UXP panel.") from exc

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except TimeoutError as exc:
            raise PremiereBridgeError(f"Premiere did not answer {method!r} within {timeout_seconds:g} seconds.") from exc
        finally:
            self._pending.pop(request_id, None)

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        try:
            hello = await asyncio.wait_for(self._receive_json(websocket), timeout=5)
            if hello.get("type") != "hello" or not isinstance(hello.get("token"), str):
                await websocket.close(code=4400, reason="Expected bridge hello message")
                return
            if not hmac.compare_digest(hello["token"], self._config.token):
                await websocket.close(code=4401, reason="Invalid bridge token")
                return
            if hello.get("protocolVersion") != 1:
                await websocket.close(code=4400, reason="Unsupported bridge protocol")
                return

            async with self._client_lock:
                previous = self._client
                self._client = websocket
                self._connected.set()
            if previous is not None and previous is not websocket:
                await previous.close(code=4409, reason="Replaced by a newer Premiere panel")

            await websocket.send(
                json.dumps(
                    {"type": "hello_ack", "protocolVersion": 1, "endpoint": self.endpoint},
                    separators=(",", ":"),
                )
            )
            async for raw_message in websocket:
                await self._receive_message(raw_message)
        except (ConnectionClosed, PremiereBridgeProtocolError):
            pass
        finally:
            await self._clear_client(websocket)

    async def _receive_json(self, websocket: ServerConnection) -> dict[str, Any]:
        raw_message = await websocket.recv()
        return self._decode_message(raw_message)

    async def _receive_message(self, raw_message: str | bytes) -> None:
        message = self._decode_message(raw_message)
        if message.get("type") != "response":
            raise PremiereBridgeProtocolError("Only response messages are allowed after authentication.")

        request_id = message.get("id")
        if not isinstance(request_id, str):
            raise PremiereBridgeProtocolError("Response id must be a string.")
        future = self._pending.get(request_id)
        if future is None or future.done():
            return

        if message.get("ok") is True and isinstance(message.get("result"), dict):
            future.set_result(message["result"])
            return

        error = message.get("error", "Premiere returned an invalid error response.")
        future.set_exception(PremiereBridgeError(str(error)))

    @staticmethod
    def _decode_message(raw_message: str | bytes) -> dict[str, Any]:
        if isinstance(raw_message, bytes):
            raise PremiereBridgeProtocolError("Binary bridge messages are not supported.")
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError as exc:
            raise PremiereBridgeProtocolError("Bridge message is not valid JSON.") from exc
        if not isinstance(message, dict):
            raise PremiereBridgeProtocolError("Bridge message must be a JSON object.")
        return message

    async def _clear_client(self, websocket: _Connection) -> None:
        async with self._client_lock:
            if self._client is not websocket:
                return
            self._client = None
            self._connected.clear()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(PremiereBridgeNotConnected("Premiere UXP panel disconnected."))
