"""Unit tests for the local Premiere UXP bridge protocol."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from gospelo_mediakit.premiere.bridge import (
    BridgeConfig,
    PremiereBridge,
    PremiereBridgeError,
    PremiereBridgeProtocolError,
)


class _FakeConnection:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, message: str) -> None:
        self.sent.append(message)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        return None


def _bridge() -> PremiereBridge:
    config = BridgeConfig(
        host="127.0.0.1",
        port=47653,
        token="x" * 32,
        certificate_path=Path("unused-cert.pem"),
        private_key_path=Path("unused-key.pem"),
    )
    bridge = PremiereBridge(config)
    # Unit tests exercise the RPC protocol, not TLS or a real network listener.
    bridge._server = object()  # type: ignore[assignment]
    return bridge


def test_config_rejects_non_loopback_host(monkeypatch):
    monkeypatch.setenv("GOSPELO_PREMIERE_BRIDGE_HOST", "0.0.0.0")
    with pytest.raises(PremiereBridgeError, match="loopback"):
        BridgeConfig.from_environment()


def test_config_requires_long_token(monkeypatch):
    monkeypatch.setenv("GOSPELO_PREMIERE_BRIDGE_TOKEN", "short")
    with pytest.raises(PremiereBridgeError, match="at least 32"):
        BridgeConfig.from_environment()


def test_request_round_trip():
    async def run() -> None:
        bridge = _bridge()
        connection = _FakeConnection()
        bridge._client = connection
        bridge._connected.set()

        request_task = asyncio.create_task(
            bridge.request("project.assets.list", {"includeBins": True}, timeout_seconds=1)
        )
        await asyncio.sleep(0)
        assert len(connection.sent) == 1
        request = json.loads(connection.sent[0])
        assert request["method"] == "project.assets.list"
        assert request["params"] == {"includeBins": True}

        await bridge._receive_message(
            json.dumps(
                {
                    "type": "response",
                    "id": request["id"],
                    "ok": True,
                    "result": {"project": {"name": "Edit"}, "assets": []},
                }
            )
        )
        assert await request_task == {"project": {"name": "Edit"}, "assets": []}

    asyncio.run(run())


def test_request_rejects_methods_not_exposed_by_the_plugin():
    async def run() -> None:
        bridge = _bridge()
        with pytest.raises(PremiereBridgeProtocolError, match="Unsupported"):
            await bridge.request("arbitrary.eval", {}, timeout_seconds=1)

    asyncio.run(run())


def test_error_response_is_returned_to_the_mcp_tool():
    async def run() -> None:
        bridge = _bridge()
        connection = _FakeConnection()
        bridge._client = connection
        bridge._connected.set()
        request_task = asyncio.create_task(bridge.request("project.assets.list", {}, timeout_seconds=1))
        await asyncio.sleep(0)
        request_id = json.loads(connection.sent[0])["id"]

        await bridge._receive_message(
            json.dumps({"type": "response", "id": request_id, "ok": False, "error": "No project open"})
        )
        with pytest.raises(PremiereBridgeError, match="No project open"):
            await request_task

    asyncio.run(run())
