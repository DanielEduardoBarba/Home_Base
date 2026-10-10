"""VPN/LAN advertise host selection for project run/expo env injection."""

from __future__ import annotations

import pytest

from server import network


def test_advertise_host_prefers_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOMEBASE_ADVERTISE_HOST", "10.8.0.1")
    monkeypatch.setattr(
        network,
        "list_ipv4_interfaces",
        lambda: [("wlp1s0", "192.168.1.50"), ("wg0", "10.8.0.1")],
    )
    assert network.advertise_host() == "10.8.0.1"


def test_advertise_host_prefers_wireguard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOMEBASE_ADVERTISE_HOST", raising=False)
    monkeypatch.setattr(
        network,
        "list_ipv4_interfaces",
        lambda: [("wlp1s0", "192.168.1.50"), ("wg0", "10.8.0.1")],
    )
    assert network.advertise_host() == "10.8.0.1"


def test_advertise_host_falls_back_to_lan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOMEBASE_ADVERTISE_HOST", raising=False)
    monkeypatch.setattr(
        network,
        "list_ipv4_interfaces",
        lambda: [("wlp1s0", "192.168.1.50")],
    )
    assert network.advertise_host() == "192.168.1.50"


def test_project_lan_env_sets_expo_and_next(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOMEBASE_ADVERTISE_HOST", "10.8.0.1")
    env = network.project_lan_env(
        [("api", 4200), ("web", 3200), ("expo", 8200)]
    )
    assert env["REACT_NATIVE_PACKAGER_HOSTNAME"] == "10.8.0.1"
    assert env["EXPO_PUBLIC_API_URL"] == "http://10.8.0.1:4200/api/v1"
    assert env["NEXT_PUBLIC_API_URL"] == "http://10.8.0.1:4200/api/v1"
    assert env["WEB_ORIGIN"] == "http://10.8.0.1:3200"
    assert env["HOSTNAME"] == "0.0.0.0"


def test_project_lan_env_without_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOMEBASE_ADVERTISE_HOST", raising=False)
    monkeypatch.setattr(network, "advertise_host", lambda: None)
    env = network.project_lan_env([("api", 4100)])
    assert env == {"HOSTNAME": "0.0.0.0"}
    assert "EXPO_PUBLIC_API_URL" not in env


def test_list_ipv4_falls_through_empty_netifaces(monkeypatch: pytest.MonkeyPatch) -> None:
    """If netifaces imports but finds nothing, still try `ip` / hostname paths."""

    class _FakeNetifaces:
        AF_INET = 2

        @staticmethod
        def interfaces() -> list[str]:
            return ["lo"]

        @staticmethod
        def ifaddresses(_iface: str) -> dict:
            return {}

    monkeypatch.setitem(__import__("sys").modules, "netifaces", _FakeNetifaces())
    monkeypatch.setattr(
        network.subprocess,
        "run",
        lambda *a, **k: type(
            "R",
            (),
            {"returncode": 0, "stdout": "2: wg0    inet 10.6.0.1/24 scope global wg0\n"},
        )(),
    )
    addrs = network.list_ipv4_interfaces()
    assert ("wg0", "10.6.0.1") in addrs
