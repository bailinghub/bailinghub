# Bailing Connect Java SDK

Business-side SDK for Java 11+ services.

It provides:

- ticket signing for authenticated web chat visitors
- HMAC verification for tool calls
- callback verification
- authorization probe helper
- OpenAPI tool spec builder
- a lightweight HubClient for `/run`, `/jobs/{id}`, and `/send`

## Compile Example

```bash
javac -d /tmp/bailing-java sdk/java/src/main/java/com/bailing/connect/BailingConnect.java sdk/java/examples/BuildSpec.java
java -cp /tmp/bailing-java BuildSpec
```

## Ticket

```java
String ticket = BailingConnect.signTicket("client-token", tenantId + ":" + userId);
```

## Verify Tool Call

```java
boolean ok = BailingConnect.verifyToolCall(
    secret,
    method,
    pathWithQuery,
    rawBody,
    timestamp,
    signature,
    onBehalfOf,
    jobId,
    300
);
```

Verification proves the call came from the hub. Your business service must still authorize `onBehalfOf` against its own permission table.

## Omitted and explicit declaration values

Unspecified `risk`, `readonly`, and `idempotent` fields stay absent from ACC. Explicit low/medium/high risk and both boolean values are preserved, including false on GET. With risk omitted, the ACC OpenAPI binding gives an explicit readonly value precedence over the HTTP method: GET without a readonly declaration defaults to low; other non-readonly operations default to medium. Risk does not replace approval or final business authorization.

Regenerate and compare declarations when upgrading; do not turn previously omitted risk into explicit low for all operations. An unspecified `Tool.risk` is now null rather than `"low"`; code that reads the intermediate Tool object must handle null. `readonly` and `idempotent` remain nullable Boolean values.

```bash
javac -d /tmp/bailing-java sdk/java/src/main/java/com/bailing/connect/BailingConnect.java sdk/java/tests/DeclarationTest.java
java -cp /tmp/bailing-java DeclarationTest
```

This checks 24 readonly/risk combinations and 6 idempotency combinations.
