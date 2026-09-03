# Friction log — building an Alexa+ MCP add-on

Kept live while building, not reconstructed afterwards. Each entry records where we
lost time, what we expected, and what would have prevented it.

---

## 1. The authentication page in the add-ons docs returns 404

**Expected:** `developer.amazon.com/docs/alexaplus/add-ons/mcp-authentication.html`
to explain the OAuth 2.1 + PKCE flow, since the QuickStart names OAuth 2.1 with
PKCE (S256) as a requirement but does not describe the flow.

**Got:** HTTP 404.

**Cost:** We had to design the identity model without knowing what Alexa+ actually
passes to the MCP server on each tool call.

**Consequence for the design — this is the important part.** Because we could not
confirm whether Alexa+ forwards any per-speaker identity (voice profile, household
member id, device id) to the MCP server, we deliberately built the whole
authorization model on the OAuth access token alone, which is the one identity we
know is real. A product that *could* have personalised per household member is
instead uniform per linked account. If that context is in fact available, the docs
gap directly cost the add-on a feature.

**What would have prevented it:** a single table in the QuickStart listing every
field the server receives on a tool call, with an example JSON-RPC request. This is
the first thing any MCP server author needs and it is currently absent.

---

## 2. "Minimum acceptable version is 2025-11-25" with no conformance check

**Expected:** a way to verify our server actually satisfies the required MCP spec
version before deploying — a linter, a `alexa-ai validate --spec`, anything.

**Got:** the version is stated as a requirement in the hackathon rules and the
toolkit overview, but nothing verifies it. The MCP TypeScript SDK advertises its
own supported versions, which may or may not match, and the failure mode if they
diverge is a deploy-time or runtime error rather than a build-time one.

**Cost:** Time spent reading SDK source to determine which spec version is
negotiated, rather than building the product.

**What would have prevented it:** `alexa-ai validate` performing protocol
introspection against the declared MCP server URL and reporting the negotiated
version, before `alexa-ai deploy` is run.

---

## 3. The 500 ms round-trip limit is documented but not measurable locally

**Expected:** a way to measure, during development, whether we are inside the
budget the platform enforces.

**Got:** "Must meet a round-trip query response latency of less than 500 ms" as
prose. It is not stated whether the budget covers the network hop from Alexa+ to
the server, the server's own handler time, or both; whether it is measured per
tool call or per turn; or what happens when it is exceeded — refusal, retry,
truncation, or a spoken error.

**Cost:** We built our own timing harness and budgeted defensively, assuming the
500 ms includes the network round trip and that our handler therefore has far less.
That assumption shaped the data layer: everything is in-process, because we could
not risk an external database hop.

**What would have prevented it:** stating what the budget covers and what happens
on breach. A developer who assumes handler-only time will build something that
works locally and fails in production.

---

## 4. Two onboarding paths, and the recommended one requires trusting a code agent

**Observed, not a complaint.** The QuickStart's Path A hands scaffolding to an AI
coding agent that introspects your MCP server and auto-fills `shortDescription`,
`fullDescription` and `examplePhrases` from your tool definitions.

This is genuinely good, and it worked. What is worth flagging: those three fields
are what a customer reads before enabling the add-on, and generated ones are
plausible but generic. There is no prompt in the flow saying "these were written
from your tool schemas; rewrite them in your own voice before submitting." A lot
of add-ons will ship with machine-written store copy.

**Suggestion:** have `alexa-ai deploy` warn when a description is byte-identical to
what the scaffolder generated.

---

*(Entries continue as the build progresses.)*
