from __future__ import annotations

from homebase_entry import self_test


def test_self_test_smoke():
    assert self_test() == 0
