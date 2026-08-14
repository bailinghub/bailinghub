# BailingHub v0.3.4: Anonymous Preview and Trusted Business Identity Guidance

`v0.3.4` clarifies the user journey between a chat-entry preview, the built-in demo, and a real trusted business identity. The console action previously presented as a generic trial chat is now explicitly labeled **Anonymous Preview**, so administrators and visitors are not led to assume that a BailingHub console session automatically becomes a business-operation subject.

## Main changes

- **Explicit anonymous-preview semantics**: the chat-entry list, embed dialog, and standalone preview page now state that the preview does not inherit the BailingHub administrator session and has no standalone business-login surface.
- **Accurate no-subject guidance**: when a conversation has no trusted identity ticket signed by the business backend, the Agent explains that the user must return to the real business system, sign in there, and reopen or refresh the assistant. It must not claim that the preview can perform a login or ask for an account, password, token, or user ID.
- **Separate demo validation path**: after managed demo configuration is imported, Getting Started presents **Run Demo-Subject Smoke** as the next explicit action. Smoke uses a controlled demo subject and creates a real job and trace. Importing configuration does not run a task automatically and does not promote the administrator into a business subject.
- **More precise ticket configuration**: the console now explains that the business-identity ticket issuer only declares which client may sign tickets for the entry. A trusted business subject exists only when the backend of an authenticated business system signs a short-lived ticket and its page supplies `data-ticket`.

## Identity and authorization boundary

This release does not relax any identity or tool gate:

- `visitor_id` remains anonymous conversation continuity data, not an identity credential;
- without a verified ticket that establishes a trusted subject, every tool declared with `subject.required:true`, including read-only queries and writes, remains hidden from the Agent;
- ticket verification establishes a trusted business subject and makes subject-required tools eligible, but the real business system must still perform final authorization from On-Behalf-Of and its own permissions;
- a BailingHub administrator is never automatically converted into a business user.

## Compatibility and upgrade

- There is no new database migration or Schema change. `054_demo_dataset_state.sql` remains the latest migration.
- There is no new or changed HTTP API, Client API, Kernel Host API v1, chat protocol, Executor Protocol, ACC contract, ticket format, tool signature, or approval semantic.
- Existing anonymous entries and ticket-bearing embeds require no integration change. The changes primarily improve console, preview-page, and no-subject response semantics.
- Deployments on `v0.3.3` can upgrade as a normal patch release.

## Validation

The release gate covers the complete `npm run release:check`, no-subject tool-assembly tests, the anonymous-preview page contract, real-browser console E2E, demo-subject Smoke, bilingual documentation, and npm artifact consistency.

## Related documentation

- [Quickstart](QUICKSTART.en.md)
- [Chat entry and identity contract](CONTRACT.en.md)
- [Docker Demo](DEMO.en.md)
- [User guide: core concepts](user-guide/concepts.en.md)
- [中文发布说明](RELEASE_NOTES_v0.3.4.md)
