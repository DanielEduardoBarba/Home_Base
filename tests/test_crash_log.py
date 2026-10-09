from __future__ import annotations

import json

from server.crash_log import incident_level, journal_incident_lines, record_event, replay_events


def test_incident_level_skips_access_logs():
    line = 'INFO: 192.168.0.2:60138 - "GET /api/notifications?limit=25 HTTP/1.1" 200 OK'
    assert incident_level(line) is None


def test_incident_level_flags_stop_and_traceback():
    assert incident_level("Stopping homebased.service - Home Base control plane") == "warn"
    assert incident_level("INFO: Shutting down") == "warn"
    assert incident_level("Traceback (most recent call last):") == "error"
    assert incident_level("homebased.service: Main process exited, code=killed, status=9/KILL") == "error"


def test_journal_incident_lines_keeps_the_stop_sequence():
    text = "\n".join(
        [
            'INFO: 127.0.0.1 - "GET /api/health HTTP/1.1" 200 OK',
            "Stopping homebased.service - Home Base control plane (homebased)...",
            "INFO: Shutting down",
            "INFO: Application shutdown complete.",
            "homebased.service: Deactivated successfully.",
        ]
    )
    levels = [lvl for lvl, _ in journal_incident_lines(text)]
    assert levels == ["warn", "warn", "warn"]


def test_record_and_replay_roundtrip(tmp_path, monkeypatch):
    import server.crash_log as crash_log

    path = tmp_path / "service-events.jsonl"
    monkeypatch.setattr(crash_log, "EVENTS_PATH", path)
    record_event("error", "uncaught exception:\nboom")
    record_event("warn", "homebased shutting down")
    saved = [json.loads(ln) for ln in path.read_text().splitlines()]
    assert [row["message"] for row in saved] == [
        "uncaught exception:\nboom",
        "homebased shutting down",
    ]
    n = replay_events()
    assert n == 2
    assert not path.exists()
    assert replay_events() == 0
