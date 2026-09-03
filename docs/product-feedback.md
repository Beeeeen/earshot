# Product feedback (required submission field)

## Which tools, APIs and SDKs did you use?

Alexa+ MCP Toolkit and the `alexa-ai` CLI; the Model Context Protocol
TypeScript SDK, targeting spec version 2025-11-25 over Streamable HTTP; the MCP
Apps extension for the card rendered in the conversation view; OAuth 2.1 with
PKCE (S256) for account linking.

## What worked well

**The MCP server is the whole integration.** We had a working server before we
had an Amazon developer account, and the add-on was a wrapper around something
that already existed. That is the right shape — it means the platform is a
distribution channel rather than a rewrite, and it is the single biggest reason
this project was possible in the time available.

**The scaffolder reading the MCP server is genuinely good.** `alexa-ai new mcp`
introspecting the tool schemas and proposing descriptions and example phrases
removed most of the tedium of the manifest.

**Refusals-as-return-values fits voice better than it fits chat.** Nothing in the
toolkit forced this, but the platform's shape encouraged it: a spoken error is
much worse than a spoken alternative, so returning a usable next step instead of
throwing turned out to be the right default. Worth documenting as a pattern.

## What needs improvement

**The authentication page 404s.** `docs/alexaplus/add-ons/mcp-authentication.html`
is linked and returns 404. OAuth 2.1 + PKCE is named as a requirement in the
QuickStart, and then the page that would explain it is missing.

**There is no reference for what the server receives on a tool call.** This cost
us a feature. We could not determine whether Alexa+ forwards any per-speaker
identity — voice profile, household member, device id — so we built the entire
authorization model on the access token alone, which is the one identity we could
confirm. In a product about who is allowed to hear what, that is a significant
design decision made blind. One table listing every field on an inbound call,
with an example JSON-RPC request, would fix it.

**The 500 ms budget is stated but not scoped or measurable.** It is not said
whether it covers the network hop, the handler, or both; whether it is per call
or per turn; or what happens on breach — refusal, retry, truncation, or a spoken
error. We assumed the worst and put the entire data layer in-process. A developer
who assumes handler-only time will build something that passes locally and fails
in production. `alexa-ai` should be able to measure a deployed add-on against the
real budget and report the margin.

**Nothing checks the MCP spec version before deploy.** "Minimum acceptable
version is 2025-11-25" is a requirement with no validator. `alexa-ai validate`
should introspect the declared server URL and report the negotiated version.

## How was onboarding?

Fast where it was documented and a dead end where it was not. The path from zero
to a deployed development-stage add-on is short and well signposted. The path to
understanding what your server actually receives at runtime does not exist yet.
Onboarding for an MCP add-on is not really about scaffolding — that part is
solved — it is about the runtime contract, and that is the part that is missing.

## Would you build with these again?

Yes, and the reason is specific rather than polite. Voice is the only interface
where the output is heard by people who did not ask for it, and that turns out to
be a rich constraint to design against rather than an obstacle. We would not have
found this idea on any other platform. What would make the difference next time is
a documented runtime contract — with it, the same add-on could have been
per-person instead of per-account.
