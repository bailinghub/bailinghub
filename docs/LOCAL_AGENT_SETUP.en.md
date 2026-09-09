# Configure a local agent in one place

English | [简体中文](LOCAL_AGENT_SETUP.md)

Open **Agent Clients → Connection Setup**, then choose **Configure Connection** on the application's row, to connect an existing business system to a local agent. The panel brings authorization, system descriptions, tools and approvals, and connection checks into four steps.

Settings stay in their existing Client and business route records. The older pages retain advanced controls and link to this entry point; there is no second set of application identities or business capabilities to maintain.

## Understand the three roles

| Name | What it controls | Example |
| --- | --- | --- |
| Client | Which application connects, where users authorize, and which workspaces it may use | The client identifier and fixed authorization page for a support application |
| Workspace (business route) | System purpose, tool sources, and local-agent execution settings | Customer support or inventory operations |
| Agent Session | The authorized user, tenant/account, and permitted business scope | An operator acting for a particular account |

Allowing a Client to use a workspace does not give every user all its business permissions. Requests still use the original business identity and pass scope checks, approvals, and final authorization in the business system.

Several Clients may share a workspace. Changes to its descriptions or tool sources affect other entry points using that route. Decide whether a separate workspace is needed before introducing independent settings.

## Step 1: Authorization entry

Find the existing Client and choose **Configure Connection**. If the application is not registered yet, use **New Client** first.

Check that it is enabled, enter the fixed HTTPS authorization page supplied by the business system, choose the permitted workspaces, and save. The business page handles login, account selection, and permission confirmation. Do not duplicate a Client record for every user or store.

The Client enabled switch is shared with its other entry points. Disabling it can affect an embedded chat or another integration using the same Client. To stop local-agent tool calls only, use the tool switch in step 3.

## Step 2: System description

Select the workspace, enable the local agent, and fill in four fields:

- **System name:** the product or module name, such as “Customer Support”.
- **Short purpose:** what it usually handles, such as customer questions, tickets, and follow-ups.
- **Typical domains:** a few useful categories, such as ticket lookup or response preparation.
- **Boundaries:** work handled elsewhere, such as inventory adjustments.

Save the workspace. Compatible clients provide these descriptions for the conversation's selected targets before the first tool search, helping the model choose where to look. Single-account, multiple-account, and multiple-system conversations use the same structure.

Missing metadata, older versions, or temporary description failures may display “System purpose unknown”; existing authorization and on-demand tool discovery remain available through their original flow. A description is not a permission grant or an instruction to bypass rules. See the [system information contract](AGENT_SYSTEM_INFO.en.md).

## Step 3: Tools and approvals

Enable local-agent tool calls, select registered tool providers and allowed scopes, and choose exact write operations when needed.

| Setting | Meaning |
| --- | --- |
| Local agent enabled | Enables local conversation orchestration; tool access has a separate switch |
| Tool calls enabled | Opens discovery and invocation, still subject to providers and authorization |
| Provider scope allowlist | Selects capabilities from the business declarations |
| Allowed write operations | Explicit operation IDs; empty means no writes, and `*` is not accepted |
| Additional approvals | Can tighten existing approval requirements, never remove them |

An existing read-only route permission still prevents writes even if operations are selected. The panel shows this setting; the route's permission and audience rules remain in advanced route configuration.

Choose **Read Tool Catalog** to see a table of business-action descriptions and operation IDs, whether each is a read or write, and its current configuration. Review these actions before adjusting scopes, allowed writes, and approvals.

Reading the catalog does not execute an operation or prove that an end user may execute it. Additional orchestration rules and active-tool limits remain under advanced runtime settings, separate from the product description.

Save the workspace. Steps 2 and 3 edit the same workspace settings; save changes you want to keep before switching workspaces.

## Step 4: Check the connection

Review the saved Client, authorization page, and workspace states, then generate connection settings. These tell the local client where the Hub is and which Client and workspace to use, plus a local display label. They contain no tokens and do not authorize a user automatically.

Give these public settings to the local client. The user then signs in and confirms authorization on the business page. A new conversation explicitly selects its authorization scope and keeps it fixed after the first message; changing scope follows the client's new-conversation flow.

“Connection settings ready” is not proof that tools are available or that business work has executed. The client must validate the user and actual authorization. After that, use your test process to verify a permitted read, a controlled action, and approval when required.

Authorized devices, runs, and usage remain under **Devices and Activity** on the same page.

## Resolve setup problems

| State | Next step |
| --- | --- |
| Description missing | Use existing discovery and add a product description later |
| Connection ready, tool calls disabled | Check the step 3 switch, providers, and scope |
| Workspace disabled or read-only | Review advanced route settings; the panel does not silently change them |
| Permission denied | Use an administrator with the relevant Client or route permissions |
| Configuration changed concurrently | Close and reopen the panel, review current values, and save again |
| Host cannot save these settings | Upgrade its matching persistence implementation; do not fall back to overwriting the whole record |

## API appendix: narrow updates

These endpoints use administrator authentication and RBAC, not an end user's Agent bearer. Client and route settings are saved separately; the panel does not provide a transaction across both records.

### Client settings

`GET /admin/api/clients/:app_id/agent-setup` returns `app_id`, `name`, `enabled`, `agent_authorize_url`, `allowed_routes`, and `revision`, without the Client Token.

`PUT` to the same path requires exactly these four fields:

```json
{
  "expected_revision": "<revision returned by GET>",
  "enabled": true,
  "agent_authorize_url": "https://business.example.com/agent/authorize",
  "allowed_routes": ["helpdesk"]
}
```

Set `agent_authorize_url` to `null` to clear it. `allowed_routes` accepts up to 256 entries and retains the existing workspace/`*` meaning; explicit workspaces make the affected scope easier to assess. The revision covers these three editable settings. Saving updates only them, without rotating tokens or changing other Client properties.

GET requires `clients:read`; PUT requires `clients:write`. Errors include 403 `forbidden`, 404 `client_not_found`, and 400 `invalid_agent_setup` or an existing configuration validation error.

### Workspace settings

`GET /admin/api/routes/:route_key/agent-setup` returns `route_key`, `name`, `enabled`, `permission`, `revision`, `agent_client`, `tool_sources`, and `agent_direct`. `permission` is read-only and must not be sent in a PUT.

`PUT` requires exactly `expected_revision`, `agent_client`, `tool_sources`, and `agent_direct`. `agent_client` and `agent_direct` may be `null`; `tool_sources: []` clears source selection. Edit freshly read values while preserving existing instructions, tool limits, and extra source settings. See the [complete example](AGENT_SYSTEM_INFO.en.md#console-configuration-api).

GET requires `routes:read`; PUT requires `routes:write`. The full route revision is compared, but only `agent_client`, `tools`, and the update timestamp are written. Target, permission, audience, memory, knowledge, and unrelated settings remain unchanged. Errors include 404 `route_not_found` and 400 `invalid_request` or an existing route validation error.

Both revision formats are 64 hexadecimal characters. A concurrent edit returns 409 `agent_setup_conflict`; a host without the corresponding atomic persistence operation returns 503 `agent_setup_unsupported`. Neither path silently overwrites a conflicting record. Successful saves return the new projection and revision.

This feature uses existing storage fields and adds no migration. Business APIs, approval rules, fixed conversation scope, and archive protocols remain unchanged.
