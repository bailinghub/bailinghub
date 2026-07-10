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
