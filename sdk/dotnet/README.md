# Bailing Connect .NET SDK

Business-side SDK for .NET 8 services.

It provides:

- ticket signing for authenticated web chat visitors
- HMAC verification for tool calls
- callback verification
- authorization probe helper
- OpenAPI tool spec builder
- a lightweight HubClient for `/run`, `/jobs/{id}`, and `/send`

## Run Example

```bash
dotnet run --project sdk/dotnet/examples/BuildSpec/BuildSpec.csproj
```

## Ticket

```csharp
var ticket = BailingConnect.SignTicket("client-token", tenantId + ":" + userId);
```

## Verify Tool Call

```csharp
var ok = BailingConnect.VerifyToolCall(secret, method, pathWithQuery, rawBody, timestamp, signature, onBehalfOf, jobId);
```

Verification proves the call came from the hub. Your business service must still authorize `onBehalfOf` against its own permission table.

## Omitted and explicit declaration values

Unspecified `risk`, `readonly`, and `idempotent` fields stay absent from ACC. Explicit low/medium/high risk and both boolean values are preserved, including false on GET. With risk omitted, the ACC OpenAPI binding gives an explicit readonly value precedence over the HTTP method: GET without a readonly declaration defaults to low; other non-readonly operations default to medium. Risk does not replace approval or final business authorization.

Regenerate and compare declarations when upgrading; do not turn previously omitted risk into explicit low for all operations. The default `Tool.Risk` is now the empty string rather than `"low"`; it represents omission and retains the existing string property type. `Readonly` and `Idempotent` continue to use null for omission.

Run `dotnet run --project sdk/dotnet/tests/Declaration/Declaration.csproj` for 24 readonly/risk combinations and 6 idempotency combinations.
