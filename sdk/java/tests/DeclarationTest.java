import com.bailing.connect.BailingConnect;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** No network or business operations: exercises the actual OpenAPI builder. */
public final class DeclarationTest {
    @SuppressWarnings("unchecked")
    private static Map<String, Object> capability(BailingConnect.Tool tool) {
        Map<String, Object> spec = BailingConnect.buildOpenApiSpec("Fixture", "1", List.of(tool), null);
        Map<String, Object> paths = (Map<String, Object>) spec.get("paths");
        Map<String, Object> path = (Map<String, Object>) paths.get("/fixture");
        Map<String, Object> operation = (Map<String, Object>) path.get(tool.method.toLowerCase());
        return (Map<String, Object>) operation.get("x-agent-capability");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static BailingConnect.Tool fixture(String method) {
        return new BailingConnect.Tool("Declaration serialization fixture", "fixture.write", "/fixture")
            .method(method).name("serialization_fixture")
            .param(new BailingConnect.Param("fixture"));
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) {
        int matrix = 0;
        int idempotency = 0;
        for (String method : List.of("GET", "POST")) {
            for (Boolean readonly : new Boolean[] { null, false, true }) {
                for (String risk : new String[] { null, "low", "medium", "high" }) {
                    BailingConnect.Tool tool = fixture(method);
                    if (readonly != null) tool.readonly(readonly);
                    if (risk != null) tool.risk(risk);
                    Map<String, Object> cap = capability(tool);
                    Map<String, Object> execution = (Map<String, Object>) cap.getOrDefault("execution", Map.of());
                    String label = method + " readonly=" + readonly + " risk=" + risk;
                    check(execution.containsKey("readonly") == (readonly != null), label + " readonly presence");
                    if (readonly != null) check(Objects.equals(execution.get("readonly"), readonly), label + " readonly value");
                    check(cap.containsKey("risk") == (risk != null), label + " risk presence");
                    if (risk != null) check(risk.equals(((Map<?, ?>) cap.get("risk")).get("level")), label + " risk value");
                    boolean expectedReadonly = readonly != null ? readonly : "GET".equals(method);
                    String expectedRisk = risk != null ? risk : (expectedReadonly ? "low" : "medium");
                    boolean effectiveReadonly = (Boolean) execution.getOrDefault("readonly", "GET".equals(method));
                    String effectiveRisk = cap.containsKey("risk")
                        ? (String) ((Map<?, ?>) cap.get("risk")).get("level") : (effectiveReadonly ? "low" : "medium");
                    check(expectedRisk.equals(effectiveRisk), label + " effective risk");
                    check(Integer.valueOf(1).equals(cap.get("version")), label + " declaration version");
                    String json = BailingConnect.toJson(cap);
                    if (readonly != null) check(json.contains("\"readonly\":" + readonly), label + " serialized readonly");
                    if (risk != null) check(json.contains("\"level\":\"" + risk + "\""), label + " serialized risk");
                    matrix++;
                }
            }
            for (Boolean value : new Boolean[] { null, false, true }) {
                BailingConnect.Tool tool = fixture(method);
                if (value != null) tool.idempotent(value);
                Map<String, Object> cap = capability(tool);
                Map<String, Object> execution = (Map<String, Object>) cap.getOrDefault("execution", Map.of());
                check(execution.containsKey("idempotent") == (value != null), method + " idempotent presence");
                if (value != null) check(Objects.equals(execution.get("idempotent"), value), method + " idempotent value");
                idempotency++;
            }
        }
        check(matrix == 24 && idempotency == 6, "matrix completeness");
        System.out.println("PASS: 24 readonly/risk combinations + 6 idempotent combinations");
    }
}
