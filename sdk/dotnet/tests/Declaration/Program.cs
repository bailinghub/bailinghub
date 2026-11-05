using System.Text.Json;
using Bailing.Connect;

static JsonElement Capability(Tool tool)
{
    var spec = BailingConnect.BuildOpenApiSpec("Fixture", "1", [tool]);
    using var json = JsonDocument.Parse(BailingConnect.ToJson(spec));
    return json.RootElement.GetProperty("paths").GetProperty("/fixture")
        .GetProperty(tool.Method.ToLowerInvariant()).GetProperty("x-agent-capability").Clone();
}

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static Tool Fixture(string method, bool? readonlyValue = null, string risk = "", bool? idempotent = null)
{
    // Exercise the real property default when risk is omitted.
    if (risk == "") return new Tool
    {
        Name = "serialization_fixture", Description = "Declaration serialization fixture",
        Scope = "fixture.write", Path = "/fixture", Method = method,
        Readonly = readonlyValue, Idempotent = idempotent,
        Params = [new Param { Name = "fixture" }]
    };
    return new Tool
    {
        Name = "serialization_fixture", Description = "Declaration serialization fixture",
        Scope = "fixture.write", Path = "/fixture", Method = method,
        Readonly = readonlyValue, Risk = risk, Idempotent = idempotent,
        Params = [new Param { Name = "fixture" }]
    };
}

int matrix = 0, idempotency = 0;
foreach (var method in new[] { "GET", "POST" })
{
    foreach (bool? readonlyValue in new bool?[] { null, false, true })
    {
        foreach (var risk in new[] { "", "low", "medium", "high" })
        {
            var cap = Capability(Fixture(method, readonlyValue, risk));
            var hasExecution = cap.TryGetProperty("execution", out var execution);
            JsonElement readonlyJson = default;
            var hasReadonly = hasExecution && execution.TryGetProperty("readonly", out readonlyJson);
            var label = $"{method} readonly={readonlyValue} risk={risk}";
            Check(hasReadonly == readonlyValue.HasValue, label + " readonly presence");
            if (readonlyValue.HasValue) Check(readonlyJson.GetBoolean() == readonlyValue.Value, label + " readonly value");
            var hasRisk = cap.TryGetProperty("risk", out var riskJson);
            Check(hasRisk == (risk != ""), label + " risk presence");
            if (hasRisk) Check(riskJson.GetProperty("level").GetString() == risk, label + " risk value");
            var expectedReadonly = readonlyValue ?? (method == "GET");
            var expectedRisk = risk != "" ? risk : (expectedReadonly ? "low" : "medium");
            var effectiveReadonly = hasReadonly ? readonlyJson.GetBoolean() : method == "GET";
            var effectiveRisk = hasRisk ? riskJson.GetProperty("level").GetString() : (effectiveReadonly ? "low" : "medium");
            Check(effectiveRisk == expectedRisk, label + " effective risk");
            Check(cap.GetProperty("version").GetInt32() == 1, label + " declaration version");
            matrix++;
        }
    }
    foreach (bool? value in new bool?[] { null, false, true })
    {
        var cap = Capability(Fixture(method, idempotent: value));
        var hasExecution = cap.TryGetProperty("execution", out var execution);
        JsonElement idempotentJson = default;
        var present = hasExecution && execution.TryGetProperty("idempotent", out idempotentJson);
        Check(present == value.HasValue, method + " idempotent presence");
        if (value.HasValue) Check(idempotentJson.GetBoolean() == value.Value, method + " idempotent value");
        idempotency++;
    }
}
Check(matrix == 24 && idempotency == 6, "matrix completeness");
Console.WriteLine("PASS: 24 readonly/risk combinations + 6 idempotent combinations");
