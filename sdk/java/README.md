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
