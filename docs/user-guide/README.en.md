# User Guide

This guide is for business owners, product managers, system administrators, implementation consultants, and operators who want to add Agent capabilities to an existing business system.

It does not replace developer documentation. Developer docs explain HTTP, signatures, SDKs, and code. This guide explains what problem each BailingHub object solves, how to translate a business goal into console configuration, and what to hand to developers after configuration.

## Who Should Read This

- You operate an existing ERP, CRM, order, service, store, or internal management system.
- You want an Agent to answer questions, query live business data, or initiate controlled business actions.
- You do not want Agent logic, model credentials, governance, and audit code duplicated across every business system.
- You have installed BailingHub but need a business-oriented map of the console.

## Reading Order

| Document | Question answered |
|---|---|
| [overview.en.md](overview.en.md) | Why does an existing system need an Agent control plane? |
| [concepts.en.md](concepts.en.md) | How do routes, callers, targets, tools, knowledge, and channels relate? |
| [console-map.en.md](console-map.en.md) | What does each console menu do and what does it produce? |
| [scenarios.en.md](scenarios.en.md) | How do I configure a concrete business scenario step by step? |

## Open-Source Edition Boundary

The open-source edition is designed for one organization: one administration domain, one audit space, and one shared set of operators. It can connect multiple business systems, callers, routes, models, targets, tool providers, and channels. If mutually untrusted organizations require hard isolation, deploy separate open-source instances.

## What You Should Be Able To Produce

After reading this guide, you should be able to define:

- where a request enters: backend event, web chat, or an inbound messaging channel;
- which brain handles it: a hosted model, local OpenAI-compatible model, or executor-based Agent;
- which business capabilities the Agent may reach across one or more tool providers;
- which knowledge, page context, media, and conversation memory are assembled;
- how results return through polling, callback, webhook, or channel delivery;
- which high-risk calls become durable approval intents.

You can then give developers the generated call example, caller token, tool-signing secret, widget code, ticket requirements, or callback contract.

