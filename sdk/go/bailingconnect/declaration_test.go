package bailingconnect

import (
	"encoding/json"
	"fmt"
	"testing"
)

func declarationFixture(method string) Tool {
	return Tool{Name: "serialization_fixture", Description: "Declaration serialization fixture", Scope: "fixture.write", Path: "/fixture", Method: method, Params: []Param{{Name: "fixture", Type: "string"}}}
}

func serializedCapability(t *testing.T, tool Tool) map[string]any {
	t.Helper()
	spec := BuildOpenAPISpec("Fixture", "1", []Tool{tool}, nil)
	encoded, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	method := "get"
	if tool.Method == "POST" {
		method = "post"
	}
	return decoded["paths"].(map[string]any)["/fixture"].(map[string]any)[method].(map[string]any)["x-agent-capability"].(map[string]any)
}

func executionOf(cap map[string]any) map[string]any {
	if execution, ok := cap["execution"].(map[string]any); ok {
		return execution
	}
	return map[string]any{}
}

func TestDeclarationReadonlyRiskMatrix(t *testing.T) {
	no, yes := false, true
	cases := 0
	for _, method := range []string{"GET", "POST"} {
		for ri, readonly := range []*bool{nil, &no, &yes} {
			for _, risk := range []string{"", "low", "medium", "high"} {
				cases++
				t.Run(fmt.Sprintf("%s/readonly_%d/risk_%s", method, ri, risk), func(t *testing.T) {
					tool := declarationFixture(method)
					tool.Readonly, tool.Risk = readonly, risk
					cap := serializedCapability(t, tool)
					execution := executionOf(cap)
					gotReadonly, hasReadonly := execution["readonly"]
					if hasReadonly != (readonly != nil) || (readonly != nil && gotReadonly != *readonly) {
						t.Fatalf("readonly not preserved: %#v", cap)
					}
					gotRisk, hasRisk := cap["risk"]
					if hasRisk != (risk != "") || (risk != "" && gotRisk.(map[string]any)["level"] != risk) {
						t.Fatalf("risk not preserved: %#v", cap)
					}
					expectedReadonly := method == "GET"
					if readonly != nil {
						expectedReadonly = *readonly
					}
					expectedRisk := risk
					if expectedRisk == "" {
						expectedRisk = "medium"
						if expectedReadonly {
							expectedRisk = "low"
						}
					}
					effectiveReadonly := method == "GET"
					if hasReadonly {
						effectiveReadonly = gotReadonly.(bool)
					}
					effectiveRisk := "medium"
					if effectiveReadonly {
						effectiveRisk = "low"
					}
					if hasRisk {
						effectiveRisk = gotRisk.(map[string]any)["level"].(string)
					}
					if effectiveRisk != expectedRisk {
						t.Fatalf("effective risk = %s, want %s", effectiveRisk, expectedRisk)
					}
				})
			}
		}
	}
	if cases != 24 {
		t.Fatalf("matrix contains %d cases", cases)
	}
}

func TestDeclarationIdempotentPresence(t *testing.T) {
	no, yes := false, true
	for _, method := range []string{"GET", "POST"} {
		for i, value := range []*bool{nil, &no, &yes} {
			t.Run(fmt.Sprintf("%s/idempotent_%d", method, i), func(t *testing.T) {
				tool := declarationFixture(method)
				tool.Idempotent = value
				execution := executionOf(serializedCapability(t, tool))
				actual, present := execution["idempotent"]
				if present != (value != nil) || (value != nil && actual != *value) {
					t.Fatalf("idempotent not preserved: %#v", execution)
				}
			})
		}
	}
}
