#!/usr/bin/env python3
"""Offline unit + fake-transport integration tests for listener_v2.py.

NO network, NO access code, NO Firestore library needed: every test
drives pure functions or EventProcessor with hand-built dicts / fake
snapshot objects. The real gRPC adapter is deliberately NOT exercised
here (it needs a live stream + a credential, which is a live-check
item for a human, listed in README-listener.md).

Run:  python3 test_listener_v2.py
Exit 0 = all PASS. The final line reports the PASS count.
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from listener_v2 import (  # noqa: E402
    normalize_text, extract_mentions, build_event_id, classify_event_type,
    detect_event, should_skip, is_rate_limited, BackoffPolicy,
    CircuitBreaker, StateStore, EventProcessor, health_status,
    start_time_for_collection, snapshot_to_doc, atomic_write_json,
    MAX_CONSECUTIVE_RESTARTS, RATE_LIMIT_BACKOFF_SECS,
    DEFAULT_LOOKBACK_MINUTES, read_boot_time,
)

COORD = "coordinator"
STAFF = "staff"


def msg(mid="m1", sender_id="tuan", sender_name="Tuấn", kind="Trao đổi",
        content="hello", ts="2026-10-24T10:00:00.000Z", collection="messages",
        **extra):
    d = {"collection": collection, "id": mid, "senderId": sender_id,
         "senderName": sender_name, "kind": kind, "content": content,
         "createdAt": ts, "updatedAt": "", "decidedAt": "",
         "updateTime": ""}
    d.update(extra)
    return d


def staff_names(names="Hung"):
    return [normalize_text(n) for n in names.split(",") if n.strip()]


# ---- fake transport: mimics the Firestore snapshot objects the real
# adapter converts, without any library or network. ----

class FakeDoc:
    def __init__(self, doc_id, data, update_time=None):
        self.id = doc_id
        self._data = data
        self.update_time = update_time

    def to_dict(self):
        return dict(self._data)


class FakeChangeType:
    def __init__(self, name):
        self.name = name


class FakeChange:
    def __init__(self, type_name, document):
        self.type = FakeChangeType(type_name)
        self.document = document


class FakeStream:
    """Delivers pre-scripted batches, then 'disconnects' (raises).

    Reconnect = a new FakeStream over the same batches: the processor
    must NOT re-emit anything already delivered (replay dedup).
    """

    def __init__(self, batches, fail_after=None):
        self.batches = list(batches)
        self.fail_after = fail_after
        self.delivered = 0

    def read_batches(self, processor):
        emitted = []
        for batch in self.batches:
            if self.fail_after is not None and \
                    self.delivered >= self.fail_after:
                raise ConnectionError("simulated network loss")
            converted = [(c, ch.type.name, snapshot_to_doc(c, ch.document))
                         for c, ch in batch]
            emitted.extend(processor.process_batch(converted))
            self.delivered += 1
        return emitted


def mk_processor(tmpdir, mode=STAFF, names="Hung", sender_id="hung"):
    state = StateStore(os.path.join(tmpdir, "state.json"))
    proc = EventProcessor(mode, staff_names(names), sender_id, state,
                          os.path.join(tmpdir, "events.jsonl"))
    return proc, state


def read_events(tmpdir):
    path = os.path.join(tmpdir, "events.jsonl")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


class TestNormalize(unittest.TestCase):
    def test_hung(self):
        self.assertEqual(normalize_text("Hùng"), "hung")

    def test_tuan(self):
        self.assertEqual(normalize_text("Tuấn"), "tuan")

    def test_dang(self):
        self.assertEqual(normalize_text("Đặng"), "dang")

    def test_muse(self):
        self.assertEqual(normalize_text("Muse"), "muse")

    def test_mentions(self):
        self.assertEqual(extract_mentions("hello @Hùng, xem giúp"),
                         ["hung"])
        self.assertEqual(extract_mentions("nhờ @Muse. làm"), ["muse"])
        self.assertEqual(extract_mentions("không có nhắc ai"), [])
        self.assertEqual(extract_mentions("gọi @Tuan nhé"), ["tuan"])


class TestDetectCoordinator(unittest.TestCase):
    def test_chairman_message(self):
        self.assertEqual(
            detect_event(msg(sender_id="chung", sender_name="Chung"),
                         COORD, ["muse"], "Muse"),
            ("message", "chairman"))

    def test_chairman_assignment_is_chairman_first(self):
        self.assertEqual(
            detect_event(msg(sender_id="chung", sender_name="Chung",
                             kind="Giao việc", content="làm X"),
                         COORD, ["muse"], "Muse"),
            ("message", "chairman"))

    def test_mention_muse(self):
        self.assertEqual(
            detect_event(msg(content="@Muse xem giúp"), COORD,
                         ["muse"], "Muse"),
            ("message", "mention"))

    def test_assignment_from_staff(self):
        self.assertEqual(
            detect_event(msg(kind="Giao việc", content="giao Tuấn làm Y"),
                         COORD, ["muse"], "Muse"),
            ("message", "assignment"))

    def test_own_by_id_ignored(self):
        self.assertIsNone(
            detect_event(msg(sender_id="Muse", sender_name="Muse"),
                         COORD, ["muse"], "Muse"))

    def test_own_by_name_ignored(self):
        self.assertIsNone(
            detect_event(msg(sender_id="x", sender_name="Muse"),
                         COORD, ["muse"], "Muse"))

    def test_plain_staff_chat_not_coordinator_event(self):
        self.assertIsNone(
            detect_event(msg(content="chào mọi người"), COORD,
                         ["muse"], "Muse"))


class TestDetectStaff(unittest.TestCase):
    def test_mention_accented(self):
        self.assertEqual(
            detect_event(msg(content="@Hùng ơi", sender_id="tuan",
                             sender_name="Tuấn"), STAFF,
                         staff_names("Hung"), "hung"),
            ("message", "mention"))

    def test_mention_unaccented(self):
        self.assertEqual(
            detect_event(msg(content="@Hung ơi", sender_id="tuan",
                             sender_name="Tuấn"), STAFF,
                         staff_names("Hung"), "hung"),
            ("message", "mention"))

    def test_mention_tuan_variants(self):
        for text in ("@Tuấn nhé", "@Tuan nhé", "@tuấn nhé"):
            self.assertEqual(
                detect_event(msg(content=text, sender_id="hung",
                                 sender_name="Hùng"), STAFF,
                             staff_names("Tuan"), "tuan"),
                ("message", "mention"))

    def test_chairman_not_naming_staff_does_not_wake_staff(self):
        # KEY RULE: a Chairman message with no staff name wakes the
        # coordinator only -- never this staff member.
        self.assertIsNone(
            detect_event(msg(sender_id="chung", sender_name="Chung",
                             content="mọi người chú ý tiến độ"),
                         STAFF, staff_names("Hung"), "hung"))

    def test_chairman_naming_staff_wakes_via_mention(self):
        self.assertEqual(
            detect_event(msg(sender_id="chung", sender_name="Chung",
                             content="@Hùng xem giúp anh"),
                         STAFF, staff_names("Hung"), "hung"),
            ("message", "mention"))

    def test_assignment_naming_staff(self):
        self.assertEqual(
            detect_event(msg(kind="Giao việc",
                             content="giao Hùng làm báo cáo"),
                         STAFF, staff_names("Hung"), "hung"),
            ("message", "assignment"))

    def test_assignment_naming_other_staff_does_not_wake(self):
        self.assertIsNone(
            detect_event(msg(kind="Giao việc",
                             content="giao Tuấn làm báo cáo"),
                         STAFF, staff_names("Hung"), "hung"))

    def test_own_message_ignored_even_with_mention(self):
        self.assertIsNone(
            detect_event(msg(sender_id="hung", sender_name="Hùng",
                             content="@Hùng tự nhắc"),
                         STAFF, staff_names("Hung"), "hung"))


class TestTaskApprovalSystem(unittest.TestCase):
    def test_staff_task_assigned_by_name(self):
        doc = msg(collection="tasks", sender_id="", sender_name="",
                  content="viết báo cáo", assigneeName="Hùng")
        self.assertEqual(detect_event(doc, STAFF, staff_names("Hung"),
                                      "hung"),
                         ("task_event", "assignment"))

    def test_staff_task_assigned_by_id(self):
        doc = msg(collection="tasks", sender_id="", sender_name="",
                  assigneeId="hung")
        self.assertEqual(detect_event(doc, STAFF, staff_names("Hung"),
                                      "hung"),
                         ("task_event", "assignment"))

    def test_staff_task_for_someone_else_ignored(self):
        doc = msg(collection="tasks", sender_id="", sender_name="",
                  assigneeName="Tuấn")
        self.assertIsNone(detect_event(doc, STAFF, staff_names("Hung"),
                                       "hung"))

    def test_coordinator_task_event(self):
        doc = msg(collection="tasks", sender_id="", sender_name="",
                  assigneeName="Tuấn")
        self.assertEqual(detect_event(doc, COORD, ["muse"], "Muse"),
                         ("task_event", "task_change"))

    def test_staff_approval_naming_self(self):
        doc = msg(collection="approvals", sender_id="", sender_name="",
                  assigneeName="Hùng", content="xin duyệt")
        self.assertEqual(detect_event(doc, STAFF, staff_names("Hung"),
                                      "hung"),
                         ("approval_event", "approval"))

    def test_coordinator_approval_event(self):
        doc = msg(collection="approvals", sender_id="", sender_name="",
                  assigneeName="Tuấn")
        self.assertEqual(detect_event(doc, COORD, ["muse"], "Muse"),
                         ("approval_event", "approval"))

    def test_system_event_coordinator(self):
        doc = msg(kind="Thông báo", sender_id="chung",
                  sender_name="Chung", content="hệ thống bảo trì")
        self.assertEqual(classify_event_type(doc), "system_event")
        self.assertEqual(detect_event(doc, COORD, ["muse"], "Muse"),
                         ("system_event", "system"))

    def test_system_event_staff_not_mentioned(self):
        doc = msg(kind="Thông báo", sender_id="chung",
                  sender_name="Chung", content="hệ thống bảo trì")
        self.assertIsNone(detect_event(doc, STAFF, staff_names("Hung"),
                                       "hung"))

    def test_system_event_staff_mentioned(self):
        doc = msg(kind="Thông báo", content="@Hùng chú ý",
                  sender_id="tuan", sender_name="Tuấn")
        self.assertEqual(detect_event(doc, STAFF, staff_names("Hung"),
                                      "hung"),
                         ("system_event", "mention"))


class TestEventIdAndDedup(unittest.TestCase):
    def test_added_id(self):
        self.assertEqual(build_event_id("messages", "m1", "ADDED"),
                         "messages:m1")

    def test_modified_same_update_time_same_id(self):
        a = build_event_id("messages", "m1", "MODIFIED",
                           "2026-10-24T10:00:00.000Z")
        b = build_event_id("messages", "m1", "MODIFIED",
                           "2026-10-24T10:00:00.000Z")
        self.assertEqual(a, b)

    def test_modified_new_update_time_new_id(self):
        a = build_event_id("messages", "m1", "MODIFIED",
                           "2026-10-24T10:00:00.000Z")
        b = build_event_id("messages", "m1", "MODIFIED",
                           "2026-10-24T10:05:00.000Z")
        self.assertNotEqual(a, b)

    def test_skip_by_emitted_id(self):
        self.assertTrue(should_skip("messages:m1",
                                    "2026-10-24T10:00:00.000Z", "m1",
                                    ("", ""), {"messages:m1"}))

    def test_skip_by_checkpoint_older_ts(self):
        self.assertTrue(should_skip(
            "messages:m0", "2026-10-24T09:00:00.000Z", "m0",
            ("2026-10-24T10:00:00.000Z", "m9"), set()))

    def test_skip_by_checkpoint_same_ts_smaller_id(self):
        self.assertTrue(should_skip(
            "messages:m1", "2026-10-24T10:00:00.000Z", "m1",
            ("2026-10-24T10:00:00.000Z", "m9"), set()))

    def test_no_skip_newer_than_checkpoint(self):
        self.assertFalse(should_skip(
            "messages:m9", "2026-10-24T11:00:00.000Z", "m9",
            ("2026-10-24T10:00:00.000Z", "m1"), set()))


class TestProcessorFakeTransport(unittest.TestCase):
    def test_batch_with_duplicates_emits_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            doc = msg(content="@Hùng ơi")
            batch = [("messages", "ADDED", doc),
                     ("messages", "ADDED", dict(doc))]  # duplicate
            self.assertEqual(len(proc.process_batch(batch)), 1)
            self.assertEqual(len(read_events(tmp)), 1)

    def test_modified_resend_same_update_time_no_rewake(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            doc = msg(content="@Hùng ơi",
                      updateTime="2026-10-24T10:00:00.000Z")
            first = proc.process_batch([("messages", "ADDED", doc)])
            self.assertEqual(len(first), 1)
            again = proc.process_batch(
                [("messages", "MODIFIED", dict(doc))])
            self.assertEqual(again, [])
            self.assertEqual(len(read_events(tmp)), 1)

    def test_modified_new_update_time_is_new_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            doc = msg(content="@Hùng ơi",
                      updateTime="2026-10-24T10:00:00.000Z")
            proc.process_batch([("messages", "ADDED", doc)])
            doc2 = dict(doc, updateTime="2026-10-24T10:05:00.000Z")
            second = proc.process_batch(
                [("messages", "MODIFIED", doc2)])
            self.assertEqual(len(second), 1)
            self.assertNotEqual(first_id := read_events(tmp)[0]["event_id"],
                                read_events(tmp)[1]["event_id"])

    def test_replay_after_reconnect_no_rewake(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            doc = msg(content="@Hùng ơi")
            stream = FakeStream([[("messages",
                                   FakeChange("ADDED", FakeDoc(
                                       "m1", {"senderId": "tuan",
                                              "senderName": "Tuấn",
                                              "kind": "Trao đổi",
                                              "content": "@Hùng ơi",
                                              "createdAt": "2026-10-24T10:00:00.000Z"})))]])
            self.assertEqual(len(stream.read_batches(proc)), 1)
            # Reconnect: same snapshot delivered again, new processor
            # over the SAME state file (as after a real restart).
            proc2, _ = mk_processor(tmp)
            # NOTE: mk_processor reloads state from the same path only
            # if given the same tmpdir/state.json -- it does.
            stream2 = FakeStream(stream.batches)
            self.assertEqual(stream2.read_batches(proc2), [])
            self.assertEqual(len(read_events(tmp)), 1)

    def test_network_loss_then_resume_only_new_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            batch1 = [("messages", FakeChange(
                "ADDED", FakeDoc("m1", {"senderId": "tuan",
                                        "senderName": "Tuấn",
                                        "kind": "Trao đổi",
                                        "content": "@Hùng ơi",
                                        "createdAt": "2026-10-24T10:00:00.000Z"})))]
            batch2 = [("messages", FakeChange(
                "ADDED", FakeDoc("m2", {"senderId": "tuan",
                                        "senderName": "Tuấn",
                                        "kind": "Trao đổi",
                                        "content": "@Hùng tiếp",
                                        "createdAt": "2026-10-24T10:01:00.000Z"})))]
            stream = FakeStream([batch1, batch2], fail_after=1)
            with self.assertRaises(ConnectionError):
                stream.read_batches(proc)
            self.assertEqual(len(read_events(tmp)), 1)
            # Resume: full replay (old + new) must emit only the new.
            proc2, _ = mk_processor(tmp)
            resumed = FakeStream([batch1, batch2]).read_batches(proc2)
            self.assertEqual(len(resumed), 1)
            self.assertEqual(resumed[0]["doc_id"], "m2")

    def test_notified_vs_accepted_distinction(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            proc.process_batch([("messages", "ADDED",
                                 msg(content="@Hùng ơi"))])
            ev = read_events(tmp)[0]
            self.assertTrue(ev["notified"])
            # Acceptance is a separate downstream step: the listener
            # itself never marks a task accepted.
            self.assertFalse(ev["accepted"])

    def test_resume_from_state_file_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, state = mk_processor(tmp)
            proc.process_batch([("messages", "ADDED",
                                 msg(content="@Hùng ơi"))])
            reloaded = StateStore(os.path.join(tmp, "state.json"))
            ck_ts, ck_id = reloaded.checkpoint("messages")
            self.assertEqual(ck_ts, "2026-10-24T10:00:00.000Z")
            self.assertEqual(ck_id, "m1")
            start = start_time_for_collection(reloaded, "messages")
            self.assertEqual(
                start.strftime("%Y-%m-%dT%H:%M:%S"), "2026-10-24T10:00:00")

    def test_first_run_starts_now_minus_lookback(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = StateStore(os.path.join(tmp, "state.json"))
            before = datetime.now(timezone.utc)
            start = start_time_for_collection(
                state, "messages",
                lookback_minutes=DEFAULT_LOOKBACK_MINUTES)
            after = datetime.now(timezone.utc)
            self.assertTrue(before - timedelta(minutes=6) <= start <=
                            after - timedelta(minutes=4))


class TestBackoffCircuitRestart(unittest.TestCase):
    def test_backoff_grows_exponentially_no_jitter(self):
        p = BackoffPolicy(base=2.0, factor=2.0, max_delay=300.0,
                          jitter=False)
        self.assertEqual([p.next_delay() for _ in range(4)],
                         [2.0, 4.0, 8.0, 16.0])

    def test_backoff_capped(self):
        p = BackoffPolicy(base=100.0, factor=10.0, max_delay=300.0,
                          jitter=False)
        self.assertEqual(p.next_delay(), 100.0)
        self.assertEqual(p.next_delay(), 300.0)
        self.assertEqual(p.next_delay(), 300.0)

    def test_backoff_jitter_stays_in_range(self):
        import random as _random
        p = BackoffPolicy(base=10.0, factor=2.0, jitter=True,
                          rng=_random.Random(42))
        for _ in range(20):
            d = p.delay(0)
            self.assertTrue(5.0 <= d <= 15.0)

    def test_backoff_exhausted_returns_none(self):
        p = BackoffPolicy(base=1.0, max_attempts=2, jitter=False)
        self.assertIsNotNone(p.next_delay())
        self.assertIsNotNone(p.next_delay())
        self.assertIsNone(p.next_delay())

    def test_rate_limit_detected(self):
        self.assertTrue(is_rate_limited(Exception("429 Too Many")))
        self.assertTrue(is_rate_limited(
            Exception("RESOURCE_EXHAUSTED: quota exceeded")))
        self.assertFalse(is_rate_limited(Exception("UNAVAILABLE")))

    def test_rate_limit_pause_is_long(self):
        # A 429 must pause long and never burst-retry: the pause is
        # longer than any normal backoff cap the worker would use.
        self.assertGreaterEqual(RATE_LIMIT_BACKOFF_SECS, 300)

    def test_circuit_trips_after_limit(self):
        cb = CircuitBreaker(max_failures=5)
        for _ in range(4):
            self.assertFalse(cb.record_failure())
        self.assertTrue(cb.record_failure())
        self.assertTrue(cb.tripped)

    def test_circuit_resets_on_success(self):
        cb = CircuitBreaker(max_failures=5)
        for _ in range(4):
            cb.record_failure()
        cb.record_success()
        self.assertFalse(cb.tripped)
        self.assertEqual(cb.failures, 0)

    def test_restart_clean_run_resets(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = StateStore(os.path.join(tmp, "state.json"))
            self.assertEqual(state.begin_run(), 0)
            state.end_run(True)
            state2 = StateStore(os.path.join(tmp, "state.json"))
            self.assertEqual(state2.begin_run(), 0)

    def test_restart_abnormal_increments_and_loop_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            for _ in range(MAX_CONSECUTIVE_RESTARTS):
                st = StateStore(path)
                st.begin_run()
                st.end_run(False)
            st = StateStore(path)
            self.assertGreaterEqual(st.begin_run(),
                                    MAX_CONSECUTIVE_RESTARTS)

    def test_restart_vm_replacement_resets_counter(self):
        # Counter one short of the lock, then the machine is
        # replaced: the next start must NOT trip.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            for _ in range(MAX_CONSECUTIVE_RESTARTS):
                st = StateStore(path)
                st.begin_run(boot_time=111)
                st.end_run(False)
            st = StateStore(path)
            self.assertEqual(st.data["consecutive_restarts"],
                             MAX_CONSECUTIVE_RESTARTS - 1)
            self.assertEqual(st.begin_run(boot_time=222), 0)
            self.assertEqual(st.data["boot_time"], 222)
            # Counting resumes normally on the new boot.
            st.end_run(False)
            st2 = StateStore(path)
            self.assertEqual(st2.begin_run(boot_time=222), 1)

    def test_restart_same_boot_abnormal_increments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            st = StateStore(path)
            self.assertEqual(st.begin_run(boot_time=111), 0)
            st.end_run(False)
            st2 = StateStore(path)
            self.assertEqual(st2.begin_run(boot_time=111), 1)
            st2.end_run(False)
            st3 = StateStore(path)
            self.assertEqual(st3.begin_run(boot_time=111), 2)

    def test_restart_same_boot_loop_still_trips(self):
        # Same boot, 5 abnormal deaths: the lock is unchanged.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            for _ in range(MAX_CONSECUTIVE_RESTARTS):
                st = StateStore(path)
                st.begin_run(boot_time=111)
                st.end_run(False)
            st = StateStore(path)
            self.assertGreaterEqual(st.begin_run(boot_time=111),
                                    MAX_CONSECUTIVE_RESTARTS)
            st.mark_failed()
            self.assertEqual(st.data["run_state"], "failed")

    def test_restart_missing_saved_boot_time_initializes(self):
        # Pre-upgrade state file: abnormal history, no boot_time key.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            st = StateStore(path)
            st.begin_run(boot_time=111)
            st.end_run(False)
            st2 = StateStore(path)
            st2.begin_run(boot_time=111)
            st2.end_run(False)
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual(data["consecutive_restarts"], 1)
            del data["boot_time"]
            atomic_write_json(path, data)
            st3 = StateStore(path)
            self.assertIsNone(st3.data["boot_time"])
            # First run under the new code: initialize, do NOT count.
            self.assertEqual(st3.begin_run(boot_time=222), 0)
            self.assertEqual(st3.data["boot_time"], 222)

    def test_restart_unreadable_boot_time_falls_back(self):
        # Boot time unreadable: old counting, saved value untouched.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            st = StateStore(path)
            self.assertEqual(st.begin_run(boot_time=111), 0)
            st.end_run(False)
            st2 = StateStore(path)
            self.assertEqual(st2.begin_run(boot_time=None), 1)
            self.assertEqual(st2.data["boot_time"], 111)

    def test_read_boot_time_parses_btime(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "stat")
            with open(path, "w", encoding="utf-8") as f:
                f.write("cpu  1 2 3\nbtime 1700000000\nintr 0\n")
            self.assertEqual(read_boot_time(path), 1700000000)

    def test_read_boot_time_missing_returns_none(self):
        self.assertIsNone(read_boot_time("/nonexistent/path/stat"))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "stat")
            with open(path, "w", encoding="utf-8") as f:
                f.write("cpu  1 2 3\n")
            self.assertIsNone(read_boot_time(path))


class TestHealthCheck(unittest.TestCase):
    def test_health_status_from_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "status.json")
            atomic_write_json(path, {
                "pid": 1234, "stream_connected": True, "events_total": 7,
                "last_event_ts": "2026-10-24T10:00:00.000Z",
                "last_error": "", "consecutive_restarts": 2,
                "run_state": "running",
                "updated_at": "2026-10-24T10:05:00.000Z"})
            hs = health_status(path)
            for key in ("pid", "stream_connected", "events_total",
                        "last_event_ts", "last_error", "restart_count"):
                self.assertIn(key, hs)
            self.assertEqual(hs["pid"], 1234)
            self.assertEqual(hs["restart_count"], 2)
            self.assertTrue(hs["stream_connected"])

    def test_health_status_missing_file(self):
        hs = health_status("/nonexistent-dir-xyz/status.json")
        self.assertFalse(hs["ok"])


class TestDecidedStream(unittest.TestCase):
    def _approval(self, **extra):
        base = dict(mid="a1", collection="approvals", sender_id="director",
                    sender_name="Giám đốc", kind="Duyệt",
                    content="duyệt việc X", ts="2026-10-24T10:00:00.000Z",
                    requesterId="hung", requesterName="Hùng")
        base.update(extra)
        return msg(**base)

    def test_decided_stream_emits_distinct_event_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, state = mk_processor(tmp)
            doc = self._approval(decidedAt="2026-10-24T11:00:00.000Z")
            evs = proc.process_batch(
                [("approvals", "ADDED", doc, "approvals-decided")])
            self.assertEqual(len(evs), 1)
            self.assertEqual(evs[0]["event_id"],
                             "approvals:a1:decided:2026-10-24T11:00:00.000Z")
            self.assertEqual(evs[0]["type"], "approval_event")
            self.assertEqual(state.checkpoint("approvals-decided"),
                             ("2026-10-24T11:00:00.000Z", "a1"))

    def test_decided_stream_replay_same_decided_at_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            doc = self._approval(decidedAt="2026-10-24T11:00:00.000Z")
            proc.process_batch(
                [("approvals", "ADDED", doc, "approvals-decided")])
            again = proc.process_batch(
                [("approvals", "MODIFIED", dict(doc),
                  "approvals-decided")])
            self.assertEqual(again, [])
            self.assertEqual(len(read_events(tmp)), 1)

    def test_decided_stream_no_decided_at_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            doc = self._approval()  # decidedAt == ""
            evs = proc.process_batch(
                [("approvals", "ADDED", doc, "approvals-decided")])
            self.assertEqual(evs, [])

    def test_decided_stream_distinct_from_created_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            created = self._approval()
            proc.process_batch([("approvals", "ADDED", created)])
            decided = self._approval(decidedAt="2026-10-24T11:00:00.000Z")
            evs = proc.process_batch(
                [("approvals", "ADDED", decided, "approvals-decided")])
            self.assertEqual(len(evs), 1)
            self.assertEqual(len(read_events(tmp)), 2)
            ids = [e["event_id"] for e in read_events(tmp)]
            self.assertIn("approvals:a1", ids)
            self.assertIn("approvals:a1:decided:2026-10-24T11:00:00.000Z",
                          ids)

    def test_requester_wakes_on_own_approval_decision(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc, _ = mk_processor(tmp)
            doc = self._approval(decidedAt="2026-10-24T11:00:00.000Z",
                                 updateTime="2026-10-24T11:00:00.000Z")
            evs = proc.process_batch([("approvals", "MODIFIED", doc)])
            self.assertEqual(len(evs), 1)
            self.assertEqual(evs[0]["reason"], "approval")


if __name__ == "__main__":
    result = unittest.main(verbosity=1, exit=False)
    total = result.result.testsRun
    failed = len(result.result.failures) + len(result.result.errors)
    print(f"\nPASS: {total - failed}/{total}")
    sys.exit(0 if result.result.wasSuccessful() else 1)
