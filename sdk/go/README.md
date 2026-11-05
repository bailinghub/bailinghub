# Bailing Connect Go SDK

Business-side SDK for Go services.

It provides:

- ticket signing for authenticated web chat visitors
- HMAC verification for tool calls
- callback verification
- authorization probe helper
- OpenAPI tool spec builder
- a lightweight HubClient for `/run`, `/jobs/{id}`, and `/send`

## Run Example

```bash
cd sdk/go
go run ./examples/build-spec
```

## Ticket

```go
ticket, err := bailingconnect.SignTicket("client-token", tenantID+":"+userID, 7200)
```

## Verify Tool Call

```go
ok := bailingconnect.VerifyToolCall(secret, method, pathWithQuery, rawBody, timestamp, signature, onBehalfOf, jobID, 300)
```

Verification proves the call came from the hub. Your business service must still authorize `onBehalfOf` against its own permission table.

## Omitted and explicit declaration values

Unspecified `risk`, `readonly`, and `idempotent` fields stay absent from ACC. Explicit low/medium/high risk and both boolean values are preserved, including false on GET. With risk omitted, the ACC OpenAPI binding gives an explicit readonly value precedence over the HTTP method: GET without a readonly declaration defaults to low; other non-readonly operations default to medium. Risk does not replace approval or final business authorization.

Regenerate and compare declarations when upgrading; do not turn previously omitted risk into explicit low for all operations. `Tool.Risk == ""` remains the omission marker; `Readonly` and `Idempotent` use nil for omission and pointers for explicit values.

Run `go test ./...` from `sdk/go` for the 24 readonly/risk cases and 6 idempotency cases.
