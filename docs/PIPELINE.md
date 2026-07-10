# CI Pipeline Integration Example

> This is an optional integration example. The generic setup flow is in `QUICKSTART.md`; the wire contract is in `CONTRACT.md`.

Scenario: a developer pushes code, CI triggers a `code-review` route, an executor or inhub target performs read-only review, and the hub delivers the result to the developer through a configured delivery channel.

## CI Step

Add a command step after build/test:

```bash
# Decoupling rule: short timeout, never fail the CI job because the hub is unavailable.
curl -s -m 2 -X POST 'https://hub.example.com/run' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <client token from the console>' \
  -d "{
    \"request_id\": \"ci_review_${CI_COMMIT_SHA}\",
    \"route\": \"code-review\",
    \"input\": \"Review commit ${CI_COMMIT_SHA} on branch ${CI_COMMIT_BRANCH} by ${CI_COMMIT_AUTHOR}.\",
    \"source\": \"ci-pipeline\",
    \"metadata\": {
      \"committer\": \"${COMMITTER_USER_ID}\",
      \"commit\": \"${CI_COMMIT_SHA}\",
      \"branch\": \"${CI_COMMIT_BRANCH}\"
    }
  }" || true
```

Key points:

- `request_id` is the idempotency key. Re-running the same commit should not create duplicate review jobs.
- `-m 2` and `|| true` keep CI independent from the hub.
- `metadata.committer` should be the delivery-channel user id, not necessarily the Git author name. Maintain that mapping in your CI system.

```bash
case "${CI_COMMIT_AUTHOR}" in
  alice) COMMITTER_USER_ID="alice" ;;
  bob)   COMMITTER_USER_ID="bob" ;;
  *)     COMMITTER_USER_ID="" ;;
esac
```

Adjust environment variable names to your CI provider.

## Hub Route Configuration

Example `delivery` config for the `code-review` route:

```json
{ "type": "channel", "channel": "team-im", "to_field": "committer", "to": "fallback-user" }
```

- `to_field`: read the recipient from request metadata;
- `to`: fallback recipient if metadata is missing.

## Sequence

```
push → CI curl returns quickly → hub creates review job → target executes review
     → report returns to hub → delivery sends result → follow-up messages can continue on the same route/session
```

## Notes

- Use a dedicated client token for CI.
- Limit that client to the `code-review` route.
- Keep review delivery optional; the source of truth remains the CI result and the hub audit trail.
