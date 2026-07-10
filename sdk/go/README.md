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
