"""Dependency-free checks for the tool runtime's cold-spawn handoff.

Run directly: ``python3 caspar/tools/_runtime/test_tool_runtime.py`` (no pytest,
no network — mirrors the runtime's own "unit-testable with no gateway" ethos).

The invariant under test: when the node cold-spawns a serving tool it delivers
the triggering signal as ``/app/input/task.json``; the runtime must drain that
file on serve start, dispatch it, reply to the caller's ``reply_to`` with the
same ``correlationId``, and consume the file so it is handled exactly once.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_runtime():
    spec = importlib.util.spec_from_file_location("tool_runtime", os.path.join(HERE, "tool_runtime.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakeBridge:
    """Records every reply the runtime signals back to a caller."""

    def __init__(self):
        self.replies = []

    def signal_user(self, key, user_id, data):
        self.replies.append((key, user_id, data))


def _on_signal_for(tr, bridge):
    """Rebuild the runtime's serve-loop signal handler, dispatching inline."""

    def on_signal(key, data):
        if key != "creatures/signal":
            return
        packet = tr._extract_invoke(data if isinstance(data, dict) else {})
        if not packet or packet.get("kind") == "tools/result":
            return
        if not (packet.get("tool_id") or packet.get("function") or packet.get("payload")):
            return
        tr._handle_invoke(bridge, packet)  # inline (no worker thread) for the test

    return on_signal


def check(name, fn):
    try:
        fn()
    except AssertionError as exc:
        print(f"FAIL  {name}: {exc}")
        return False
    print(f"ok    {name}")
    return True


def test_cold_spawn_task_is_drained_and_replied(tr):
    d = tempfile.mkdtemp()
    tr.INPUT_DIR = d
    invoke = {
        "kind": "invoke", "entityId": "vercel_sandbox", "correlationId": "cid-1",
        "reply_to": "claude@global", "tool_id": "vercel_sandbox", "function": "write",
        "payload": {"space_id": "space-1", "path": "dummy.txt", "content": "hi"},
    }
    with open(os.path.join(d, "task.json"), "w", encoding="utf-8") as fh:
        json.dump(invoke, fh)

    bridge = _FakeBridge()
    tr._drain_pending_task(_on_signal_for(tr, bridge))

    assert not os.path.isfile(os.path.join(d, "task.json")), "task.json must be consumed exactly once"
    assert len(bridge.replies) == 1, f"expected one reply, got {bridge.replies}"
    key, user, data = bridge.replies[0]
    assert key == "creatures/signal", key
    assert user == "claude@global", "the reply must route to the caller's reply_to"
    assert data.get("kind") == "tools/result", data
    assert data.get("correlationId") == "cid-1", "the reply must carry the caller's correlationId"


def test_no_pending_task_is_a_noop(tr):
    d = tempfile.mkdtemp()
    tr.INPUT_DIR = d
    bridge = _FakeBridge()
    tr._drain_pending_task(_on_signal_for(tr, bridge))  # no task.json present
    assert bridge.replies == [], "a warm serve start (no task.json) must not reply to anyone"


def test_result_echoes_are_ignored(tr):
    d = tempfile.mkdtemp()
    tr.INPUT_DIR = d
    with open(os.path.join(d, "task.json"), "w", encoding="utf-8") as fh:
        json.dump({"kind": "tools/result", "correlationId": "x", "result": {}}, fh)
    bridge = _FakeBridge()
    tr._drain_pending_task(_on_signal_for(tr, bridge))
    assert not os.path.isfile(os.path.join(d, "task.json")), "the file is still consumed"
    assert bridge.replies == [], "a stray tools/result must never be treated as an invocation"


def main():
    tr = _load_runtime()
    passed = 0
    total = 0
    for name, fn in [
        ("a cold-spawn task.json is drained, dispatched and replied to reply_to", test_cold_spawn_task_is_drained_and_replied),
        ("no pending task.json on a warm serve start is a no-op", test_no_pending_task_is_a_noop),
        ("a tools/result left in the input dir is ignored", test_result_echoes_are_ignored),
    ]:
        total += 1
        if check(name, lambda fn=fn: fn(tr)):
            passed += 1
    print(f"\n{passed} passed, {total - passed} failed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
