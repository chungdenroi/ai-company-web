#!/usr/bin/env python3
"""Unit test OFFLINE cho post queue (drain_post_queue).

Khong goi mang, khong Firestore live. Client la fake ghi lai cac
lanc add(). Chay:
  python3 test_post_queue.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from listener_v2 import drain_post_queue  # noqa: E402


class FakeRef:
    def __init__(self, doc_id):
        self.id = doc_id


class FakeCollection:
    def __init__(self, fail_after=None):
        self.added = []
        self.fail_after = fail_after

    def add(self, doc):
        if (self.fail_after is not None
                and len(self.added) >= self.fail_after):
            raise RuntimeError("boom")
        self.added.append(doc)
        return (None, FakeRef(f"doc-{len(self.added)}"))


class FakeClient:
    def __init__(self, fail_after=None):
        self.coll = FakeCollection(fail_after=fail_after)
        self.names = []

    def collection(self, name):
        self.names.append(name)
        return self.coll


def _logs():
    lines = []

    def log(msg):
        lines.append(msg)

    return lines, log


class TestDrain(unittest.TestCase):
    def _setup(self, lines):
        tmp = tempfile.TemporaryDirectory()
        d = Path(tmp.name)
        q = d / "post-queue.jsonl"
        q.write_text("".join(l + "\n" for l in lines), encoding="utf-8")
        return tmp, d / "post-queue.jsonl", d / "post-queue.offset", \
            d / "post-queue.sent.jsonl"

    def test_posts_in_order_with_own_identity(self):
        tmp, q, off, sent = self._setup([
            json.dumps({"kind": "Trao đổi", "content": "mot"},
                       ensure_ascii=False),
            json.dumps({"kind": "Cập nhật tiến độ", "content": "hai"},
                       ensure_ascii=False)])
        client = FakeClient()
        lines, log = _logs()
        n = drain_post_queue(client, str(q), str(off), str(sent),
                             "Muse", "Muse", log)
        self.assertEqual(n, 2)
        self.assertEqual(client.names, ["messages", "messages"])
        self.assertEqual(client.coll.added[0]["senderId"], "Muse")
        self.assertEqual(client.coll.added[0]["senderName"], "Muse")
        self.assertEqual(client.coll.added[0]["kind"], "Trao đổi")
        self.assertEqual(client.coll.added[0]["content"], "mot")
        self.assertIn("createdAt", client.coll.added[0])
        self.assertEqual(client.coll.added[1]["content"], "hai")
        # Drain lan 2: khong con gi.
        self.assertEqual(drain_post_queue(
            client, str(q), str(off), str(sent), "Muse", "Muse", log), 0)
        self.assertEqual(len(client.coll.added), 2)
        sent_lines = sent.read_text(encoding="utf-8").strip().split("\n")
        self.assertEqual(len(sent_lines), 2)
        self.assertEqual(json.loads(sent_lines[0])["doc_id"], "doc-1")
        tmp.cleanup()

    def test_malformed_and_empty_lines_skipped(self):
        tmp, q, off, sent = self._setup([
            "khong phai json",
            json.dumps({"kind": "", "content": "thieu kind"}),
            json.dumps({"kind": "Trao đổi", "content": "tot"}),
        ])
        client = FakeClient()
        lines, log = _logs()
        n = drain_post_queue(client, str(q), str(off), str(sent),
                             "Muse", "Muse", log)
        self.assertEqual(n, 1)
        self.assertEqual(client.coll.added[0]["content"], "tot")
        self.assertEqual(drain_post_queue(
            client, str(q), str(off), str(sent), "Muse", "Muse", log), 0)
        tmp.cleanup()

    def test_failed_post_stops_without_advancing(self):
        tmp, q, off, sent = self._setup([
            json.dumps({"kind": "Trao đổi", "content": "mot"}),
            json.dumps({"kind": "Trao đổi", "content": "hai"}),
        ])
        client = FakeClient(fail_after=1)
        lines, log = _logs()
        n = drain_post_queue(client, str(q), str(off), str(sent),
                             "Muse", "Muse", log)
        self.assertEqual(n, 1)
        # Chi dong dau duoc offset; dong 2 cho retry.
        client.coll.fail_after = None
        n = drain_post_queue(client, str(q), str(off), str(sent),
                             "Muse", "Muse", log)
        self.assertEqual(n, 1)
        self.assertEqual(client.coll.added[1]["content"], "hai")
        tmp.cleanup()

    def test_missing_queue_file_is_zero(self):
        tmp = tempfile.TemporaryDirectory()
        d = Path(tmp.name)
        client = FakeClient()
        lines, log = _logs()
        n = drain_post_queue(client, str(d / "nope.jsonl"),
                             str(d / "nope.offset"),
                             str(d / "nope.sent.jsonl"),
                             "Muse", "Muse", log)
        self.assertEqual(n, 0)
        self.assertEqual(client.coll.added, [])
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
