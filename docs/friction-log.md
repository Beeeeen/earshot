# Friction log — building an Alexa+ MCP add-on

Kept live during the build, not reconstructed afterwards. Fields follow the ones
the rules name: task, expected, actual, **severity**, **workaround**, suggestion.

Severity scale: **Blocker** (cannot ship), **High** (cost a feature or a day),
**Medium** (cost hours), **Low** (papercut).

Several of these are protocol-conformance findings. That is the author's
background — he maintains [`mcp-probe`](https://www.npmjs.com/package/@beeeeen/mcp-probe),
a conformance and robustness suite for MCP servers — so where a claim is made
here, it was made by driving the protocol and reading the bytes, and the
observation is stated in terms a test could assert.

---

## 1. Alexa+'s documented `initialize` cannot negotiate MCP Apps, while the docs claim MCP Apps support

**Severity: Blocker** (for the feature; the add-on still works without it)

**Task.** Register a `ui://` MCP Apps resource so the private detail renders as a
card in the Alexa+ conversation view.

**Expected.** The MCP Apps extension is negotiated bilaterally. The spec is
explicit: *"Servers SHOULD check client capabilities before registering
UI-enabled tools. The SDK provides the `getUiCapability` helper for this"*
([ext-apps, specification/2026-01-26/apps.mdx](https://github.com/modelcontextprotocol/ext-apps)).
And the overview page says *"Alexa+ also supports the MCP Apps extension."*

**Actual.** The documented client `initialize`
([mcp-toolkit-client-lifecycle.html](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html))
is:

```json
{ "protocolVersion": "2025-03-26",
  "capabilities": { "roots": { "listChanged": true } } }
```

There is no `extensions` key. Running `getUiCapability` against that object
returns `undefined` — asserted in `src/selftest/apps.check.ts`. A server that
follows the spec's SHOULD offers Alexa+ nothing at all.

**Workaround.** Register the UI anyway, bind it on both the tool definition and
the tool result, and emit `earshot/uiExtensionNegotiated: false` in `_meta` so
the disagreement is visible on the wire instead of silently degrading. The card
then renders in any conformant host and is inert in Alexa+.

**Suggestion.** Either declare `extensions: { "io.modelcontextprotocol/ui": {} }`
in the documented lifecycle example, or remove the MCP Apps claim from the
overview until the client declares it. Right now a developer follows both pages
and gets a feature that cannot negotiate.

---

## 2. The docs contradict themselves on protocol version

**Severity: High** — it decides whether half the spec is available to you.

**Expected.** One version. The overview states *"Alexa+ for Builders supports the
2025-11-25 version of the MCP specification."*

**Actual.** The client-lifecycle example negotiates `2025-03-26`. Our server
negotiates down to `2025-03-26` when asked. That version **predates the
`extensions` mechanism entirely**, which is consistent with finding 1 — the
example, not the prose, looks like what ships.

**Workaround.** Support both, assert the negotiated version on the wire rather
than trusting the docs, and design so nothing essential depends on a
2025-11-25-only feature.

**Suggestion.** State the minimum and the maximum, and say which features are
gated on which. A single sentence would have saved a day of designing around a
capability that may not exist.

---

## 3. The UI binding is documented in two different places

**Severity: Medium**

**Expected.** One location. The spec puts `_meta.ui.resourceUri` on the **tool
definition**, so hosts can preload the view before the tool runs.

**Actual.** Amazon says *"as long as you have `resourceUri` defined in the tool
response"*, and every Amazon example puts it on a `tools/call` **result**.

**Workaround.** Emit both. Costs nothing and satisfies either reader.

**Suggestion.** Say explicitly that the result form is an Alexa+ extension of the
spec's definition-time binding, so developers know which one is portable.

---

## 4. Alexa ships `_meta.ui` fields that exist in no version of the spec

**Severity: Low**

**Actual.** `"invoking": "Searching hotels..."` and `"invoked": "Found hotels"`
appear in Amazon's examples. Neither is in the MCP Apps spec; both carry OpenAI
Apps SDK lineage.

**Workaround.** Additive, so safe to emit — but do not build UX that depends on
them if you want the server to work anywhere else.

**Suggestion.** Mark vendor extensions as vendor extensions in the docs.

---

## 5. Alexa's `hostContext` is not the spec's `HostContext`

**Severity: Medium** — silent misreads, not errors.

**Expected.** The spec's shape: nested `containerDimensions`, `platform:
"web" | "desktop" | "mobile"`.

**Actual.** Amazon documents `deviceClass`, `isMobile`, and flat
`maxWidth`/`maxHeight`. Code written to Alexa's shape reads `undefined` in Claude
or VS Code and lays out wrongly, with no error anywhere.

**Workaround.** Read both shapes defensively and fall back to CSS that needs
neither.

**Suggestion.** Name the divergence in the docs, or adopt the spec's shape.

---

## 6. `registerAppResource` is not in the MCP SDK

**Severity: Medium** — an hour lost to a plausible wrong assumption.

**Expected.** `@modelcontextprotocol/sdk` to carry the MCP Apps helpers, since
Amazon's docs discuss them alongside ordinary server registration.

**Actual.** Zero hits for `registerAppResource` across `sdk@1.30.0/dist`. It
lives in the separate `@modelcontextprotocol/ext-apps` package (since 0.2.2).
Amazon's quickstart does name the package, but in a position that is easy to
read past.

**Workaround.** `npm i @modelcontextprotocol/ext-apps`.

**Suggestion.** One line: *"MCP Apps helpers are in `@modelcontextprotocol/ext-apps`,
not the core SDK."*

---

## 7. The MCP Apps mime type is a media-type *parameter*, and getting it wrong fails silently

**Severity: High** — our first implementation was non-conformant and nothing said so.

**Expected.** `text/html`.

**Actual.** `text/html;profile=mcp-app`. Not plain `text/html`. And
`text/html+skybridge`, which circulates in examples elsewhere, appears nowhere in
the spec or the SDK.

**Our own bug, found by writing the conformance check:** the resource we had
registered used `text/html` and **would have been rejected by a conformant
host**. Nothing in the toolchain warned us — it registered fine, read fine, and
would simply never have rendered.

**Workaround.** Import `RESOURCE_MIME_TYPE` from `@modelcontextprotocol/ext-apps`
rather than typing the string.

**Suggestion.** `alexa-ai validate` should check the mime type of every declared
`ui://` resource. This is exactly the class of error a validator exists for.

---

## 8. The authentication page in the add-ons docs returns 404

**Severity: High** — it cost the product a feature.

**Expected.** `developer.amazon.com/docs/alexaplus/add-ons/mcp-authentication.html`
to describe the OAuth 2.1 + PKCE flow the QuickStart names as a requirement.

**Actual.** HTTP 404. (An independent reviewer hit a 404 on
`developer.amazon.com/docs/alexa-plus/add-ons/overview.html` too.)

**Consequence, which is the point.** Nothing enumerates what an MCP server
receives on an inbound tool call. We could not determine whether Alexa+ forwards
any per-speaker identity — voice profile, household member, device id — so the
entire authorization model was built on the OAuth access token alone, the one
identity we could confirm. In a product about who may hear what, that is a
significant design decision made blind. If that context does exist, this add-on
is worse than it needed to be because of a missing page.

**Workaround.** None available. We designed for the identity we could verify.

**Suggestion.** One table listing every field on an inbound tool call, with an
example JSON-RPC request. It is the first thing any MCP server author needs.

---

## 9. The 500 ms budget is stated but neither scoped nor measurable

**Severity: High** — it silently shapes your architecture.

**Expected.** To know what the budget covers and what happens when it is missed.

**Actual.** *"Must meet a round-trip query response latency of less than 500 ms"*,
as prose. It does not say whether that includes the network hop, whether it is
per call or per turn, or what a breach produces — refusal, retry, truncation, or
a spoken error.

**Consequence.** We assumed the worst, which left the handler very little, which
is why the entire data layer is in-process with no external round trips. A
developer who assumes handler-only time will build something that passes locally
and fails in production. Note that the same budget structurally rules out an LLM
round-trip inside a tool, which is worth stating outright somewhere developers
will read it.

**Workaround.** Build your own timing harness and budget defensively. Ours is
`test/latency/`, and it writes a table rather than a pass/fail.

**Suggestion.** State what the budget covers and what a breach does. Then let
`alexa-ai` measure a deployed add-on against it and report the margin.

---

## 10. Nothing validates the MCP spec version before deploy

**Severity: Medium**

**Expected.** Something to check conformance before `alexa-ai deploy`, given the
rules name a minimum spec version.

**Actual.** The version is a requirement with no validator. The SDK advertises
its own supported versions, which may or may not match, and a divergence shows
up at runtime rather than at build time.

**Workaround.** Assert the negotiated version on the wire in your own tests.

**Suggestion.** `alexa-ai validate` should introspect the declared server URL and
report the negotiated version, the declared capabilities, and any `ui://`
resource's mime type — before deploy, not after.

---

## 11. The scaffolder writes your store copy and never asks you to rewrite it

**Severity: Low** — observation, not a complaint.

Path A of the QuickStart hands scaffolding to an AI coding agent that introspects
your MCP server and fills in `shortDescription`, `fullDescription` and
`examplePhrases` from your tool definitions. This works and saves real tedium.

But those three fields are what a customer reads before enabling the add-on, and
generated ones are plausible and generic. Nothing in the flow says *"these were
written from your tool schemas; rewrite them in your own voice."* A lot of
add-ons will ship with machine-written store copy.

**Suggestion.** Have `alexa-ai deploy` warn when a description is byte-identical
to what the scaffolder produced.
