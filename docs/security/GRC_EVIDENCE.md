# Public security assessment evidence

The `Publish security assessment evidence` workflow evaluates the public
`bailinghub/bailinghub` repository against OSPS Baseline 2026-08, including
maturity levels 1, 2 and 3. It uses the signed `openssf/github-repo` evaluator
version 0.33.2 and the official GRC reusable publisher.

The publishing destination is
[bailinghub/core](https://grc.store/targets/bailinghub/core).
The first successful publication registers that target. Before that run, an
absent target page is not evidence of a completed assessment.

## Identity and permissions

Only this repository's `refs/heads/main` is bound to the corresponding GRC
namespace. The reusable workflow isolates the evaluator (read-only repository
token) from the signing/publishing job (OIDC). No long-lived credential or
organization administrator token is provided. Source code licenses are
unchanged; published assessment output uses CC0-1.0.

GRC currently requires the exact `@v1` workflow reference in its signing
identity. It rejects a commit-pinned caller. The reviewed tag resolved to
`0cbfef2f58ea147021d3657d7b18ed89920f2f6d` on 2026-11-11.
Review upstream changes to this trust root before relying on later runs.

## Running and interpreting it

Pull requests modifying the workflow run an unsigned dry run. Manual runs
default to dry-run mode; select `dry_run=false` on main to publish. Evidence
document changes on main and the weekly schedule publish fresh assessments.
There is no production deployment or product release in this workflow.

The scanner reads GitHub repository state and the current default branch;
a dry run on a pull request does not assess the pull request's proposed source
as if it had already merged. Published coordinates carry the triggering main
commit, and each result also needs its collection time and repository evidence
checked when reviewing a possible concurrent branch update.

A green publishing job means a result was stored, not that the baseline passed.
Read each requirement's verdict, evidence, coverage and assessed scope.
Failed, Needs Review, Unknown and Not Run outcomes must remain visible.
The restricted token cannot observe every administrative control; supplement
such gaps with independently collected, current evidence.

Covering all maturity tags is not a claim of meeting Level 3, receiving
certification, or earning a Security Slam badge. The evaluator itself warns
that higher-level checks are less rigorously tested. Manual governance
requirements, including genuine non-author human review, cannot be satisfied
by an automated scan or by changing a status label.
