# BailingHub Core Security Self-Assessment

[简体中文](SECURITY_SELF_ASSESSMENT.zh-CN.md).

This maintainer self-assessment describes the repository's design, development
practices, threats and remaining gaps. It follows the [OpenSSF written
self-assessment outline](https://github.com/ossf/security-assessments/blob/main/guidance/self-assessment/template/self-assessment.md). Completing this document does not mean all OSPS
requirements pass, that an independent audit has occurred, or that a deployed
instance has been assessed.

## Metadata

| Item | Assessment |
| --- | --- |
| Assessment stage | Complete written self-assessment of the scope below; control coverage and remediation remain partial. |
| Assessment date | 2026-10-12 |
| Software | [BailingHub Core](https://github.com/bailinghub/bailinghub) |
| Source baseline | `d3073cc3700343f6367b8914b1e6753ec9e9d645`; public package version 0.9.0. |
| Security provider | Yes: governed access to business capabilities. It does not replace business authorization. |
| Languages and platform | TypeScript/JavaScript, SQL, Vue, reference SDKs; Node.js 22 and MySQL. |
| Dependency inventory | [Core lockfile](package-lock.json), [console lockfile](web-admin/package-lock.json), [third-party notices](THIRD_PARTY_NOTICES.md). Lockfiles are not a generated SPDX/CycloneDX SBOM. |
| Assessor | Repository maintainer identified in [GOVERNANCE.md](GOVERNANCE.md). |

### Security links

[Security policy](SECURITY.md), [governance](GOVERNANCE.md),
[contribution process](CONTRIBUTING.md), [Security Insights](security-insights.yml),
[tool governance](docs/TOOLS.en.md), [Kernel Host API](docs/KERNEL_HOST_API.en.md),
[Agent Client authorization](docs/AGENT_CLIENT_QUICKSTART.en.md),
[invocation inspection](docs/INVOCATION_RECEIPTS.md),
[model gateway](docs/MODEL_BILLING.en.md), and
[dependency exception policy](https://github.com/bailinghub/bailinghub/blob/d3073cc3700343f6367b8914b1e6753ec9e9d645/security/dependency-audit-exceptions.json).

## Overview

BailingHub Core connects explicitly declared business capabilities to governed
agent calls and retains runtime evidence. The assessed scope is this repository's
runtime, administration console, reference demo, schemas, migrations and SDK
sources. ACC, separately distributed adapters, client applications, product
websites and independent hosting platforms have their own assessment scopes.

### Background

Natural-language requests can select a wrong target, carry untrusted content or
request an action outside the user's authority. Core supplies execution and
identity controls around those calls. The receiving business system still owns
business truth and the final permission decision. The optional 0.9.0 model gateway
connects providers, meters usage and settles allowances asynchronously; reasoning
and workflow orchestration for that gateway remain with the local client or host.

### Actors and isolation

- Administrators control routes, credentials, model services and policy. Their
  accounts and machine-admin credentials are highly privileged.
- Clients and Agent Sessions receive bounded credentials and scopes; browsers
  must not receive business-backend Client Tokens or provider secrets.
- Core, its administration console and its state database share a management
  trust domain. A database or process compromise can expose runtime records and
  credentials; those components are not independent security boundaries.
- Business tool providers are separate network services. They must authenticate
  Core signatures and recheck the bound subject's current business permission.
- Model providers and external executors are external trust domains. Their
  output is input to governed execution, not a grant of business authority.
- A trusted embedding host may inject permitted human identities and run multiple
  Kernels. It must provide distinct database schemas and runtime roots. Instances
  in one process are not protection against a compromised process or host.

The default open-source deployment is one organization per management boundary.
Clients, routes and workspaces do not establish mutually isolated organizations.
Operators needing that isolation must use separately managed deployments or a
host that implements and verifies its own isolation boundary.

### Actions and data flow

1. Authenticate an entry request, client or Agent Session and bind its permitted
   subject and scope. Reject unauthorized management or execution access.
2. Resolve declared tools and intersect applicable route, workspace and session
   restrictions. Agent Client direct writes use exact operation identifiers.
3. Apply execution policy, risk and approval requirements. Approval freezes the
   intended parameters; later approval does not waive current business authority.
4. Sign the outbound business request and propagate the acting subject. The
   business endpoint verifies the signature and performs its own authorization.
5. Record invocation, dispatch, result, approval and audit evidence. Inspection
   reads the original record; it does not continue execution or authorize a new
   dispatch when the original outcome is unknown.
6. For model services, retain request identity, usage and the price/multiplier
   snapshot. Generation state and settlement state remain distinct. Missing
   metering stays pending rather than becoming an invented zero cost.

Sensitive material includes administrative and client credentials, provider keys,
conversation content, tool arguments, attachments and business-subject context.
Retention and access are deployment responsibilities; an audit record should not
be assumed anonymous or safe to publish.

### Goals

Preserve identity and scope at execution; prevent approval from silently changing
its intended action; make original-operation inspection distinct from dispatch;
retain reviewable state and evidence; and fail closed when required credentials,
policy bindings or migration integrity are invalid.

### Non-goals

Core does not determine a business user's legal entitlement, guarantee model
correctness, sandbox arbitrary configured business endpoints, or prove that an
external effect happened solely from a model's reply. It does not provide
organization isolation merely by assigning different route/client IDs. Gateway
plans do not take over host orchestration or restore per-turn limits. This
assessment does not certify any independent host, adapter or production service.

## Self-assessment use

This document helps maintainers and adopters identify assumptions and gaps. It is
a maintainer analysis, not an external attestation or a complete penetration test.
The source baseline is explicit so later runtime, dependency or policy changes
can be reviewed against it. Operators must assess their own credentials, network,
backup, permissions, retention and business integration before production use.

## Security functions and features

### Critical components and threat analysis

| Threat | Existing design or evidence | Residual responsibility or limit |
| --- | --- | --- |
| Forged or over-scoped business calls | Signed tool requests, subject binding, scope intersection and governed execution described in the tool and Agent Client guides. | A receiving API that skips signature or business permission checks defeats the integration boundary. |
| Prompt injection or a fabricated tool claim | Declared capability exposure, risk checks, approval intent and execution evidence remain separate from model text. | Allowed actions can still be harmful; operators must constrain tools and review high-risk policy. |
| Approval reuse or changing arguments after approval | Frozen approval intent and original invocation state; read-only receipt and execution continuation are separate contracts. | Inspection cannot prove facts that the business system never recorded; unknown effects require reconciliation. |
| Cross-instance access in an embedded host | Trusted instance identity, separate schema/runtime root, restricted injected identity and explicit Kernel lifecycle. | Host routing, credentials, filesystem permissions and process compromise remain outside Core's guarantee. |
| Credential or sensitive-record disclosure | Production token requirements, separate credential roles, private reporting and source-distribution checks. | The database, host administrator, backups and logs require protected access and suitable retention. |
| Supply-chain or migration substitution | Lockfiles, versioned artifacts, ordered migration checksums and explicit migration entry points. | Consumers must verify artifacts and image identity; a digest is not proof of independent review. |
| Lost model response or unreliable billing usage | Stable original request identity, result inspection and distinct generation/settlement states. | Actual provider pricing and usage mapping require operator verification; concurrent usage can create recorded overage. |

### Security-relevant configuration

Protect management endpoints, use a strong non-placeholder root secret outside
public source, restrict database privileges and egress, and keep TLS and reverse
proxy configuration under trusted administration. Configure tool allowlists,
subject requirements, approval policy and retention for the actual business
workflow. Test pause/recovery behavior and backups. An exposed demo or test
configuration is not a production security configuration.

## Project compliance

No PCI-DSS, ISO, GDPR, CRA or other compliance certification is claimed here. ACC
compatibility is a declaration/runtime interoperability question, not a security
certification. The OSPS Baseline catalog used for the initial collection was
`osps-baseline-2026-08`, limited to Maturity Level 1 collection; that selection does
not establish the repository's final maturity level or overall compliance.

The 2026-10-10 [initial public scan](https://github.com/bailinghub/bailinghub/actions/runs/38016927247)
reported 20 Passed, 1 Failed, 3 Needs Review and 41 Not Run requirements (65 total).
A green collection workflow means execution and result retention succeeded, not
that those requirements all passed. Branch/security settings require separate
administrative evidence. The source SDK archives caused `OSPS-QA-05.02` to fail;
manual source-content comparison supports review but does not alter that result.

## Secure development practices

### Development pipeline and dependency/release integrity

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) and the documented
maintainer role. Current branch protections require checks, reject force pushes
and deletion, and apply to administrators. The recorded review configuration
requires zero approving reviewers: this is a single-maintainer project, without
an independent human two-person review gate. Protected branches are not proof of
independent review. This repository does not require every contributor commit to
be cryptographically signed.

CI covers type checks, unit/contract tests, console and reference demo checks,
package/export boundaries and dependency audit as defined in
[the workflow](.github/workflows/ci.yml). Actions use immutable commit references
and checkout avoids persistent credentials. Repository secret scanning, push
protection and dependency alerts were verified enabled; they do not guarantee
that no secret or vulnerability exists.

[Recurring Baseline evaluation](.github/workflows/osps-baseline.yml) uses the
Privateer GitHub scanner v0.31.0 with a fixed image digest, a read-only job token,
weekly scheduling and manual dispatch. Outputs are retained as workflow artifacts
for 14 days. Manual execution is observed; the first scheduled run had not been
observed at the 2026-10-12 assessment check. No new scan was triggered for this
document. Scan findings are retained as findings, not rewritten to make them pass.

Release and image workflows are separate from documentation maintenance. Tags,
image digests and migration manifests identify artifacts; this document does not
assert universal signed artifacts or independently verified provenance. New
releases require their normal artifact and runtime acceptance. Repository
self-assessment and Security Insights are governance metadata and are excluded
from the npm runtime package and Docker build context.

### Communication and ecosystem

Routine development uses repository Issues and pull requests. Sensitive reports
use the private vulnerability channel, not public Issues. Security coordination
is maintainer-led; there is no separately staffed private security team or
incident hotline documented. Release notes, repository releases and coordinated
advisories communicate relevant updates to users. Compatibility with business
APIs, ACC declarations, reference SDKs and external adapters does not establish
production adoption or extend this assessment to those projects.

## Security issue resolution

### Responsible disclosure and vulnerability response

[SECURITY.md](SECURITY.md) asks for the affected version, deployment mode,
reproduction, impact and sanitized logs through GitHub private reporting. The
maintainer targets acknowledgement within three business days and coordinates a
fix/disclosure and reporter credit after triage. The latest public release line
receives security fixes; no paid bounty or fixed resolution-time guarantee is
claimed.

### Incident response

For a confirmed repository issue, the maintainer should preserve sanitized
reproduction evidence, determine affected versions and trust boundaries, prepare
a fix with regression coverage, and coordinate disclosure and update guidance.
For a deployed credential leak or intrusion, the operator must restrict access,
rotate/revoke affected credentials, preserve protected evidence and restore from
verified artifacts/backups as appropriate. These are responsibilities and
recommended response steps, not evidence of a previously exercised incident
process. A separately tested incident playbook, response coverage and restoration
time objective have not been established by this assessment.

## Appendix

### Known issues and remaining work

Source follow-up (2026-10-15): the exception below records the 0.9.0 assessment baseline and links to that revision. Current source uses the [library-only distribution and strict audit](docs/DOCX_DEPENDENCY.en.md). This does not revise the historical assessment or establish that older deployments have been upgraded.

- `sprintf-js` advisory GHSA-hp3w-g68c-fv3c remains unresolved in the reviewed
  Mammoth CLI dependency chain. The narrowly scoped, source-bound exception in
  [the policy](https://github.com/bailinghub/bailinghub/blob/d3073cc3700343f6367b8914b1e6753ec9e9d645/security/dependency-audit-exceptions.json) expires on 2026-11-09;
  it is not a vulnerability fix or permission to use the CLI. New findings,
  changed paths/source usage and expiry remain blocking conditions.
- Manual review must reconcile administrative controls and the SDK archive
  finding without replacing the scanner's recorded results.
- The 41 Not Run requirements need applicability and evidence review at the
  appropriate maturity level. They are neither 41 confirmed defects nor 41
  automatic passes. Broader threat testing, independent review, generated SBOM,
  artifact-signature coverage and incident exercises need further evidence.
- Observe the recurring scan and retain evidence before older artifacts expire.
  Review this assessment when credentials, execution/approval semantics, host
  boundaries, migrations, dependencies or release practices change.

### Best practices

An OpenSSF Best Practices badge or complete OSPS conformance is not claimed.
Policies, automated checks and the evidence above are a starting point. Any badge
or external assessment requires its own complete criteria and review.

### Illustrative use cases

1. A customer-service agent reads a declared order and requests a high-risk
   after-sales action. Core governs scope and approval; the order system remains
   responsible for the user's permission and actual monetary effect.
2. A local agent reconnects after losing a tool response. It inspects the original
   invocation with its still-valid authorization and keeps an unknown outcome
   unknown rather than issuing a replacement write.
3. An operator uses model services under a USD allowance. The local host plans
   the workflow; Core retains request/metering and settlement evidence without
   mistaking a missing provider usage field for zero cost.

These are design examples, not reported customer deployments or adoption claims.

### Related projects and assessment limits

[ACC](https://github.com/agent-capability/agent-capability-contract) is an
independent neutral declaration contract. Independent gateways, agent clients
and hosting platforms own their own implementation and operating security.
Reference SDKs and the demo illustrate integration; they do not confer trust on
an arbitrary backend. Neither model quality nor this self-assessment grants a
business action authority.
