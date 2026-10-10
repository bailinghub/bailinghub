#!/usr/bin/env python3
"""Validate the pinned scanner's JSON; successful collection is not compliance."""

import collections
import json
import os
import pathlib
import re
import sys

CATALOG = "osps-baseline-2026-08"
RESULTS = ("Passed", "Failed", "Needs Review", "Not Applicable", "Not Run", "Unknown")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect_results(document):
    require(isinstance(document, dict), "result must be a JSON object")
    require(document.get("service-name") == "pvtr", "unexpected scanner service")
    require(document.get("plugin-name") == "github-repo", "unexpected scanner plugin")
    require(document.get("plugin-uri") == "https://github.com/ossf/pvtr-github-repo-scanner",
            "unexpected scanner source")
    suites = document.get("evaluation-suites")
    require(isinstance(suites, list) and len(suites) == 1, "expected one evaluation suite")
    suite = suites[0]
    require(isinstance(suite, dict), "suite must be an object")
    require(suite.get("catalog-id") == CATALOG, "unexpected assessment catalog")
    require(suite.get("name") == f"pvtr_{CATALOG}", "unexpected assessment suite")
    require(suite.get("corrupted-state") is False, "assessment is incomplete or corrupted")
    require(suite.get("result") in RESULTS, "invalid suite result")
    evaluation_log = suite.get("control-evaluations")
    require(isinstance(evaluation_log, dict), "missing structured control evaluations")
    require(evaluation_log.get("metadata", {}).get("type") == "EvaluationLog",
            "unexpected evaluation artifact type")
    controls = evaluation_log.get("evaluations")
    require(isinstance(controls, list) and controls, "no repository control results")
    control_ids, requirement_ids, requirements = set(), set(), []
    for control in controls:
        require(isinstance(control, dict), "control must be an object")
        ref = control.get("control", {})
        control_id = ref.get("entry-id", "")
        require(ref.get("reference-id") == CATALOG and
                isinstance(control_id, str) and re.fullmatch(r"OSPS-[A-Z]{2}-\d{2}", control_id),
                "invalid control reference")
        require(control_id not in control_ids, "duplicate control result")
        control_ids.add(control_id)
        require(control.get("result") in RESULTS, "invalid control result")
        logs = control.get("assessment-logs")
        require(isinstance(logs, list) and logs, "control has no requirement results")
        for log in logs:
            require(isinstance(log, dict), "requirement must be an object")
            ref = log.get("requirement", {})
            requirement_id = ref.get("entry-id", "")
            require(ref.get("reference-id") == CATALOG and isinstance(requirement_id, str) and
                    re.fullmatch(re.escape(control_id) + r"\.\d{2}", requirement_id),
                    "invalid requirement reference")
            require(requirement_id not in requirement_ids, "duplicate requirement result")
            requirement_ids.add(requirement_id)
            require(log.get("result") in RESULTS, "invalid requirement result")
            steps = log.get("steps-executed", 0)
            require(type(steps) is int and steps >= 0, "invalid executed-step count")
            if log["result"] not in ("Not Run", "Unknown"):
                require(steps > 0, "requirement result has no executed assessment steps")
            requirements.append(log)
    executed = [log for log in requirements if log.get("steps-executed", 0) > 0
                and log["result"] != "Not Run"]
    require(executed, "no executed repository assessments")
    # This requires observed repository data, not only GitHub-enforced defaults.
    require(any(log["requirement"]["entry-id"] == "OSPS-QA-01.01" and
                log["result"] == "Passed" for log in executed),
            "scanner did not confirm the public repository was read")
    return controls, requirements, executed


def summary(controls, requirements, executed):
    lines = ["## OSPS Baseline collection", "", f"Catalog: `{CATALOG}` · Maturity Level 1", "",
             "| Result | Controls | Requirements |", "|:--|--:|--:|"]
    control_counts = collections.Counter(control["result"] for control in controls)
    requirement_counts = collections.Counter(log["result"] for log in requirements)
    lines += [f"| {result} | {control_counts[result]} | {requirement_counts[result]} |"
              for result in RESULTS]
    lines += ["", f"Validated {len(controls)} controls and {len(requirements)} requirements; "
              f"{len(executed)} requirements have executed results.", "",
              "Collection succeeded. This does not mean all controls passed. "
              "Needs Review, Unknown and Not Run remain unresolved; the scanner's "
              "'Possible' log count is not a pass count."]
    findings = [log for log in requirements if log["result"] in ("Failed", "Needs Review", "Unknown")]
    if findings:
        lines += ["", "### Findings requiring follow-up", "", "| Requirement | Result |",
                  "|:--|:--|"]
        lines += [f"| {log['requirement']['entry-id']} | {log['result']} |" for log in findings]
    return "\n".join(lines) + "\n"


def main():
    if len(sys.argv) != 2:
        raise ValueError("usage: osps-results.py PATH_TO_PVTR_JSON")
    document = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    report = summary(*inspect_results(document))
    print(report, end="")
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with pathlib.Path(path).open("a", encoding="utf-8") as stream:
            stream.write(report)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
        print(f"OSPS result validation failed: {error}", file=sys.stderr)
        sys.exit(1)
