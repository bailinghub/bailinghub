import com.bailing.connect.BailingConnect;
import com.bailing.connect.BailingConnect.Param;
import com.bailing.connect.BailingConnect.Tool;
import java.util.List;
import java.util.Map;

public class BuildSpec {
    public static void main(String[] args) {
        Tool memberQuery = new Tool("Query member profile", "member.read", "/api/members/{id}")
            .name("member_query")
            .method("GET")
            .requiresSubject(true)
            .param(new Param("id").in("path").required(true).description("Member ID"));

        Tool refundCreate = new Tool("Create refund request", "refund.request", "/api/refunds/requests")
            .name("refund_request_create")
            .method("POST")
            .risk("medium")
            .requiresSubject(true)
            .param(new Param("order_id").required(true).description("Order ID"))
            .param(new Param("amount").type("number").required(true).description("Refund amount"));

        Map<String, Object> spec = BailingConnect.buildOpenApiSpec(
            "CRM Tools",
            "1.0.0",
            List.of(memberQuery, refundCreate),
            Map.of("method", "POST", "path", "/.well-known/bailing/authz-probe")
        );
        System.out.println(BailingConnect.toJson(spec));
    }
}
