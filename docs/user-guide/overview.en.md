# What BailingHub Solves

## Start With A Real Business Scenario

Suppose you already run an order, store, ERP, CRM, support, or operations system. You now want an Agent to:

- answer why an order has not shipped by querying the live order system;
- create a support ticket after understanding the user's request;
- summarize today's exceptional refunds from real business data;
- answer policy questions from internal documents;
- stop and request approval before a refund, deletion, or permission change;
- leave a trace explaining which context and tools produced the answer.

Without a control plane, every business system must separately integrate models, entry channels, identity, conversation context, tool calling, approval, audit, retries, and delivery. BailingHub extracts that repeated runtime path into an independent Agent control plane.

## One-Sentence Model

BailingHub sits between business systems and Agent brains. A business system submits a task; the hub selects a route and target, assembles context, exposes only allowed business tools, enforces governance, records the trace, and returns or delivers the result.

It is not merely a chatbot and it is not a fixed workflow product.

## Where It Fits

### Add Agent Operations To An Existing System

Existing systems already have APIs, authorization, and business rules. BailingHub does not ask you to rebuild them. Developers declare selected APIs as Agent capabilities, and the Agent invokes the same business paths used by human-facing applications.

### Govern Multiple Agent Scenarios Consistently

One organization may need support, operations analysis, employee knowledge, web assistance, and messaging-channel Agents. Routes keep target, tool allowlists, knowledge, memory, delivery, and budget policy separate per scenario while sharing one governance runtime.

### Let Agents Call APIs Without Bypassing Authority

BailingHub governs reach: which route and tools an Agent can see, risk and approval policy, rate limits, signatures, and audit. The business system remains the authority: after verifying the signature, it decides whether the acting subject can perform the operation now.

### Explain And Diagnose Behavior

Every trigger creates a job and trace. Operators can inspect route selection, context assembly, knowledge references, tool arguments and results, approval state, delivery, model usage, and the final answer.

### Start Narrow And Expand Safely

Begin with read-only queries, then low-risk actions such as creating drafts or requests, and only later expose high-risk actions with explicit approval and business-side authorization.

## What It Does Not Decide

BailingHub does not decide whether employee A may refund order B, whether one store may read another store's records, or which manager approves a request. Those remain business-domain decisions.

## Five Questions Before Configuration

1. Where does the request enter?
2. What must the Agent answer or do?
3. Which live APIs and documents are required?
4. On whose behalf does it act?
5. Where must the result go?

These map to entries, routes, tool providers, subjects, context, and delivery.

## Product And Development Responsibilities

Product and operations teams define scenarios, allowed capabilities, risk, knowledge, channels, and result flow. Developers expose ACC-enabled OpenAPI operations, verify signatures, enforce business authorization, trigger `/run`, and implement callbacks or widget identity tickets.

