"""Exercise the public builder and its actual JSON output, without business calls."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bailing_connect import build_openapi_spec, param, tool


def capability(method, options):
    spec = build_openapi_spec(tools=[tool(
        name="serialization_fixture", description="Declaration serialization fixture",
        path="/fixture", scope="fixture.write", method=method,
        params=[param("fixture", type="string")], **options)])
    return json.loads(json.dumps(spec))["paths"]["/fixture"][method.lower()]["x-agent-capability"]


class DeclarationTests(unittest.TestCase):
    def test_readonly_risk_matrix(self):
        combinations = 0
        for method in ("GET", "POST"):
            for readonly in (None, False, True):
                for risk in (None, "low", "medium", "high"):
                    combinations += 1
                    with self.subTest(method=method, readonly=readonly, risk=risk):
                        options = {}
                        if readonly is not None:
                            options["readonly"] = readonly
                        if risk is not None:
                            options["risk"] = risk
                        cap = capability(method, options)
                        self.assertEqual("readonly" in cap.get("execution", {}), readonly is not None)
                        if readonly is not None:
                            self.assertIs(cap["execution"]["readonly"], readonly)
                        self.assertEqual("risk" in cap, risk is not None)
                        if risk is not None:
                            self.assertEqual(cap["risk"]["level"], risk)
                        expected_readonly = readonly if readonly is not None else method == "GET"
                        expected_risk = risk if risk is not None else ("low" if expected_readonly else "medium")
                        actual_readonly = cap.get("execution", {}).get("readonly", method == "GET")
                        actual_risk = cap.get("risk", {}).get("level", "low" if actual_readonly else "medium")
                        self.assertEqual(actual_risk, expected_risk)
                        self.assertEqual(cap["version"], 1)
        self.assertEqual(combinations, 24)

    def test_idempotent_presence_and_value(self):
        combinations = 0
        for method in ("GET", "POST"):
            for value in (None, False, True):
                combinations += 1
                with self.subTest(method=method, idempotent=value):
                    cap = capability(method, {} if value is None else {"idempotent": value})
                    self.assertEqual("idempotent" in cap.get("execution", {}), value is not None)
                    if value is not None:
                        self.assertIs(cap["execution"]["idempotent"], value)
        self.assertEqual(combinations, 6)


if __name__ == "__main__":
    unittest.main()
