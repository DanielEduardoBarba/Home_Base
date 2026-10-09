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
