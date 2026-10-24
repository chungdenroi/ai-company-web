#!/usr/bin/env python3
"""Unit test OFFLINE cho sender.py (tang gui that qua API).

Khong goi mang, khong Firestore live, khong mat khau/token that.
Moi "http" o day la ham fake ghi lai request. Chay:
  python3 test_sender.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sender import (PermissionDenied, RateLimited, SendError,  # noqa: E402
                    append_task_history, classify_status, patch_heartbeat,
                    post_message, set_work, sign_in)

T0 = "2026-10-24T10:00:00Z"
FAKE_TOKEN = "fake-token-for-test-only"
FAKE_PASSWORD = "FAKE-PASSWORD-ONLY-FOR-NOT-PRESENT-ASSERTION"


def fake_http(responses, calls):
    """responses: dict (method, url_substr) -> (status, body).
    Tra ve ham http(method, url, headers, body)."""
    def _http(method, url, headers, body):
        calls.append({"method": method, "url": url, "headers": headers,
                      "body": body})
        for (m, sub), resp in responses.items():
            if m == method and sub in url:
                return resp
        return 404, {"error": {"message": "NOT_FOUND"}}
    return _http


class TestSignIn(unittest.TestCase):
    def test_success_returns_token(self):
        calls = []
        http = fake_http({("POST", "identitytoolkit"): (200, {
            "idToken": FAKE_TOKEN, "expiresIn": "3600"})}, calls)
        token, expires = sign_in("PUBLIC-KEY", "a@aicompany.app",
                                 FAKE_PASSWORD, http=http)
        self.assertEqual(token, FAKE_TOKEN)
        self.assertEqual(expires, 3600)
        self.assertEqual(calls[0]["body"]["email"], "a@aicompany.app")

    def test_failure_message_never_contains_password(self):
        calls = []
        http = fake_http({("POST", "identitytoolkit"): (400, {
            "error": {"message": "INVALID_PASSWORD"}})}, calls)
        with self.assertRaises(SendError) as ctx:
            sign_in("PUBLIC-KEY", "a@aicompany.app", FAKE_PASSWORD,
                    http=http)
        self.assertNotIn(FAKE_PASSWORD, str(ctx.exception))


class TestPostMessage(unittest.TestCase):
    def _http_ok(self, calls):
        return fake_http({("POST", "documents/messages"): (200, {
            "name": "projects/p/databases/(default)/documents/messages/m1"})},
            calls)

    def test_post_uses_bearer_and_fields(self):
        calls = []
        payload = {"fields": {
            "senderId": {"stringValue": "linh"},
            "senderName": {"stringValue": "Linh"},
            "kind": {"stringValue": "Trao đổi"},
            "content": {"stringValue": "xin chao"},
            "createdAt": {"timestampValue": T0}}}
        name = post_message("ai-company-a51da", FAKE_TOKEN, payload,
                            http=self._http_ok(calls))
        self.assertIn("messages/m1", name)
        self.assertEqual(calls[0]["headers"]["Authorization"],
                         f"Bearer {FAKE_TOKEN}")
        self.assertEqual(calls[0]["body"], payload)
        self.assertNotIn(FAKE_TOKEN, calls[0]["url"])

    def test_429_raises_rate_limited(self):
        calls = []
        http = fake_http({("POST", "documents/messages"): (429, {
            "error": {"message": "RESOURCE_EXHAUSTED"}})}, calls)
        with self.assertRaises(RateLimited):
            post_message("p", FAKE_TOKEN, {"fields": {}}, http=http)

    def test_403_raises_permission_denied(self):
        calls = []
        http = fake_http({("POST", "documents/messages"): (403, {
            "error": {"message": "PERMISSION_DENIED"}})}, calls)
        with self.assertRaises(PermissionDenied):
            post_message("p", FAKE_TOKEN, {"fields": {}}, http=http)


class TestHeartbeatAndHistory(unittest.TestCase):
    def test_patch_heartbeat_mask_and_value(self):
        calls = []
        http = fake_http({("PATCH", "employees/e1"): (200, {})}, calls)
        self.assertTrue(patch_heartbeat("p", FAKE_TOKEN, "e1", T0,
                                        http=http))
        self.assertIn("updateMask.fieldPaths=lastCheckAt", calls[0]["url"])
        self.assertEqual(calls[0]["body"]["fields"]["lastCheckAt"],
                         {"timestampValue": T0})

    def test_append_history_uses_transform_not_overwrite(self):
        calls = []
        http = fake_http({("POST", ":commit"): (200, {})}, calls)
        entry = {"fields": {
            "jobId": {"stringValue": "j1"},
            "transition": {"stringValue": "pending->acknowledged"},
            "createdAt": {"timestampValue": T0}}}
        self.assertTrue(append_task_history("p", FAKE_TOKEN, "t1", entry,
                                            http=http))
        write = calls[0]["body"]["writes"][0]
        self.assertIn("transform", write)
        transforms = write["transform"]["fieldTransforms"]
        paths = [t["fieldPath"] for t in transforms]
        self.assertIn("history", paths)
        self.assertIn("updatedAt", paths)
        hist = [t for t in transforms if t["fieldPath"] == "history"][0]
        self.assertIn("appendMissingElements", hist)
        value = hist["appendMissingElements"]["values"][0]
        self.assertEqual(value["mapValue"]["fields"], entry["fields"])
        # Khong co PATCH ghi de history o day.
        self.assertEqual(calls[0]["method"], "POST")


class TestClassify(unittest.TestCase):
    def test_table(self):
        self.assertEqual(classify_status(200), "ok")
        self.assertEqual(classify_status(429), "rate_limited")
        self.assertEqual(classify_status(403), "denied")
        self.assertEqual(classify_status(400), "fatal")
        self.assertEqual(classify_status(500), "retryable")
        self.assertEqual(classify_status(None), "retryable")


class TestSetWork(unittest.TestCase):
    def _http_ok(self, calls):
        return fake_http({
            ("PATCH", "presence/e1"): (200, {}),
            ("PATCH", "employees/e1"): (200, {}),
            ("POST", "documents/messages"): (200, {
                "name": "projects/p/databases/(default)/documents/messages/m9"}),
        }, calls)

    def test_three_calls_in_order_and_fields(self):
        calls = []
        out = set_work("p", FAKE_TOKEN, "e1", "linh", "Linh",
                       "Viết test", task_id="t1", progress="50%",
                       blocker="", now_iso=T0, http=self._http_ok(calls))
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0]["method"], "PATCH")
        self.assertIn("presence/e1", calls[0]["url"])
        self.assertEqual(calls[0]["body"]["fields"]["status"],
                         {"stringValue": "Đang làm"})
        self.assertEqual(calls[0]["body"]["fields"]["currentWork"],
                         {"stringValue": "Viết test"})
        self.assertEqual(calls[0]["body"]["fields"]["taskId"],
                         {"stringValue": "t1"})
        self.assertEqual(calls[0]["body"]["fields"]["progress"],
                         {"stringValue": "50%"})
        self.assertEqual(calls[0]["body"]["fields"]["lastSeen"],
                         {"timestampValue": T0})
        self.assertIn("employees/e1", calls[1]["url"])
        self.assertEqual(calls[1]["body"]["fields"]["currentWork"],
                         {"stringValue": "Viết test"})
        self.assertEqual(calls[2]["method"], "POST")
        self.assertIn("documents/messages", calls[2]["url"])
        msg = calls[2]["body"]["fields"]
        self.assertEqual(msg["senderId"], {"stringValue": "linh"})
        self.assertEqual(msg["senderName"], {"stringValue": "Linh"})
        self.assertEqual(msg["kind"], {"stringValue": "Cập nhật tiến độ"})
        self.assertIn("Viết test", msg["content"]["stringValue"])
        self.assertIn("50%", msg["content"]["stringValue"])
        self.assertIn("messages/m9", out["message"])

    def test_429_on_presence_stops_before_message(self):
        calls = []
        http = fake_http({("PATCH", "presence/e1"): (429, {
            "error": {"message": "RESOURCE_EXHAUSTED"}})}, calls)
        with self.assertRaises(RateLimited):
            set_work("p", FAKE_TOKEN, "e1", "linh", "Linh", "Viết test",
                     now_iso=T0, http=http)
        self.assertEqual(len(calls), 1)

    def test_empty_work_raises_without_calls(self):
        calls = []
        with self.assertRaises(ValueError):
            set_work("p", FAKE_TOKEN, "e1", "linh", "Linh", "  ",
                     now_iso=T0, http=self._http_ok(calls))
        self.assertEqual(calls, [])

    def test_employee_doc_defaults_to_sender(self):
        calls = []
        http = fake_http({
            ("PATCH", "presence/linh"): (200, {}),
            ("PATCH", "employees/linh"): (200, {}),
            ("POST", "documents/messages"): (200, {"name": "m"}),
        }, calls)
        set_work("p", FAKE_TOKEN, "", "linh", "Linh", "Viết test",
                 now_iso=T0, http=http)
        self.assertIn("presence/linh", calls[0]["url"])
        self.assertIn("employees/linh", calls[1]["url"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
