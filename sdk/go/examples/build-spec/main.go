package main

import (
	"encoding/json"
	"fmt"

	bailingconnect "github.com/bailinghub/bailinghub/sdk/go/bailingconnect"
)

func main() {
	spec := bailingconnect.BuildOpenAPISpec("CRM Tools", "1.0.0", []bailingconnect.Tool{
		{
			Name:            "member_query",
			Method:          "GET",
			Path:            "/api/members/{id}",
			Description:     "Query member profile",
			Scope:           "member.read",
			RequiresSubject: true,
			Params: []bailingconnect.Param{
				{Name: "id", In: "path", Required: true, Description: "Member ID"},
			},
		},
		{
			Name:            "refund_request_create",
			Method:          "POST",
			Path:            "/api/refunds/requests",
			Description:     "Create refund request",
			Scope:           "refund.request",
			Risk:            "medium",
			RequiresSubject: true,
			Params: []bailingconnect.Param{
				{Name: "order_id", Required: true, Description: "Order ID"},
				{Name: "amount", Type: "number", Required: true, Description: "Refund amount"},
			},
		},
	}, map[string]string{"method": "POST", "path": "/.well-known/bailing/authz-probe"})
	raw, _ := json.MarshalIndent(spec, "", "  ")
	fmt.Println(string(raw))
}
