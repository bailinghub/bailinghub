using Bailing.Connect;

var spec = BailingConnect.BuildOpenApiSpec(
    "CRM Tools",
    "1.0.0",
    [
        new Tool
        {
            Name = "member_query",
            Method = "GET",
            Path = "/api/members/{id}",
            Description = "Query member profile",
            Scope = "member.read",
            RequiresSubject = true,
            Params = [new Param { Name = "id", In = "path", Required = true, Description = "Member ID" }]
        },
        new Tool
        {
            Name = "refund_request_create",
            Method = "POST",
            Path = "/api/refunds/requests",
            Description = "Create refund request",
            Scope = "refund.request",
            Risk = "medium",
            RequiresSubject = true,
            Params =
            [
                new Param { Name = "order_id", Required = true, Description = "Order ID" },
                new Param { Name = "amount", Type = "number", Required = true, Description = "Refund amount" }
            ]
        }
    ],
    new Dictionary<string, string> { ["method"] = "POST", ["path"] = "/.well-known/bailing/authz-probe" }
);

Console.WriteLine(BailingConnect.ToJson(spec));
