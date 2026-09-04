# Earshot

**An Alexa+ MCP add-on that treats the room as an untrusted channel.**

A home health aide is in the living room. So is a neighbour. Someone asks the
Echo whether Mum took her heart medication.

Every privacy model we have assumes there is a private screen. Voice does not
have one — in a house, the answer is heard by whoever is standing there. That
leaves two bad options: refuse, and the assistant is useless for exactly the
household that needed it; or answer, and read someone's medical history aloud to
whoever was in the room.

Earshot does the third thing. It answers the question, and moves the part that
cannot be said to a channel the room cannot hear.

> **This is not access control.** Access control decides *whether* you get an
> answer. Earshot decides *which channel carries which part of one answer.* The
> unit of disclosure is the sentence, not the request. Nothing is withheld from
> the person who asked — it is withheld from the room.

```
Sarah: "Alexa, did Mum take her pills today?"
 room  Yes. Everything due so far today was taken, on time. The next one is
       at 8:00 PM. I've sent the details to your phone.
phone  Furosemide 40 mg — taken 8:14 AM · Metoprolol succinate 25 mg — 8:19 AM
       Apixaban 5 mg — 8:07 AM · Potassium chloride 20 mEq — 8:05 AM
```

## The guarantee, and exactly where it stops

The claim is that a protected value never reaches the spoken channel. Three
layers make that true, and it matters which layer stops what.

**Layer 1 — a compile error.** `Protected<T, C>` is an opaque object type,
deliberately *not* `T & brand`, so `Protected<string>` is not a `string`.
`SpokenText` is a branded string producible only by the `say` tagged template,
whose interpolations are constrained to `string | number | SpokenText`. So
``say`she took ${med.name}` `` fails to compile, and so does a plain template
literal assigned to a `spoken` field. Nine files in [`src/negative/`](src/negative/)
prove it: eight must fail, each asserting its specific error code and origin
file, plus a positive control that must compile — otherwise "everything failed"
would look like success.

**Layer 2 — no plaintext escape at runtime.** The payload lives in an ECMAScript
`#private` field. Every stringification path — `String()`, `${}`, `+ ''`,
`JSON.stringify`, `util.inspect` — yields a random per-value taint marker rather
than the value.

Two precise notes, because the difference matters. Reflective copies (spread,
`Object.keys`, `structuredClone`) do not reach the payload either, but they
return `{label, category, classification}` and carry **no marker**, so a
reflected copy is invisible to the Layer 3 tripwire. And the marker is per value
and random, so it identifies *that* a protected value escaped, not which one.

**Layer 3 — a tripwire that throws.** Every channel exit runs `assertNoTaint`.
It throws; it does not redact. A leak quietly repaired is a leak you never learn
about.

**Where it degrades.** Layer 1 cannot stop `String(p)` or `p as any` —
TypeScript has no way to forbid a call to `String`. So, precisely:

- *A protected value is referenced in a spoken string* — a **compile error** for
  ordinary code, caught and thrown for code that casts past it. We do not claim
  this is impossible to express. A compile error is not impossibility.
- *A protected value reaches a spoken string* — prevented for every path the
  attack suite has tried, and the suite is the honest measure of that claim
  rather than this sentence. See [Known findings](#known-findings).

The stronger version of this claim — that *no* expression recovers the plaintext
without importing a reveal function — is the one worth wanting, and it is exactly
the kind of claim that is easy to write and hard to hold. We only state it where
`test/attack/` is actively trying to break it.

**The architectural decision underneath all of it:** the private payload is
never in the MCP response at all. Putting it in `structuredContent` and trusting
the model to behave is the theatre this project exists to reject. It goes
out-of-band to `GET /inbox`, authenticated with the *asker's own* token. The
model is a client of `/mcp` and holds no credentials for `/inbox`, so no prompt
can extract what was never put in its context.

The demo proves this on the wire: it greps the raw `tools/call` response bytes
for 38 seeded secrets — **964 bytes, 0 found** — including under an explicit
prompt injection in `_meta`, where the spoken sentence comes back byte-identical
to the un-attacked call.

## Run it

```bash
npm install
npm run demo        # the seven-scene story, against a real server
npm run test:all    # every suite
npm run demo:serve  # the two-pane simulator in a browser
```

`npm run demo` links a real OAuth 2.1 + PKCE (S256) account, opens a real MCP
session over Streamable HTTP, and calls real tools. Two consecutive runs are
byte-identical once timings and the ephemeral port are normalised.

## Measured

`npm run test:all`, 2026-09-04:

| | |
|---|---|
| Checks passed | **307**, 0 failed — plus 38 findings tracked separately, 13 still failing |
| MCP spec negotiated on the wire | **2025-11-25** (`@modelcontextprotocol/sdk@1.30.0`) |
| Transport | Streamable HTTP, JSON and SSE modes |
| Worst tool p95, client round trip | **11-14 ms** (loopback, varies by run) |
| Worst server-side handler time, any tool | **under 10 ms** |
| Platform budget | 500 ms — **0 calls over budget** in ~900 |

Loopback round trips do not include Amazon's network. The server-side numbers
transfer; the round trip does not.

## The eight tools

`check_adherence` · `next_dose` · `log_dose` · `report_symptom` ·
`care_summary` · `who_can_see` · `open_solo_window` · `disclosure_ledger`

Identity comes from the OAuth token, not from a voice. Grants are an explicit
table: the daughter and the visiting aide ask the same question on the same
device and get different answers. `who_can_see` is deliberately spoken aloud —
who holds access is exactly the thing that should be said in the room.

`open_solo_window` is the escape hatch: five minutes, one device, one asker,
expires on its own, one ledger row per revealed field. It **fails closed** if
the transport supplies no session id — without one, "this device" is meaningless
and a window would unlock every device at once.

## What this does not do

- **It does not stop someone reading over your shoulder.** The private channel is
  a screen, and screens are visible.
- **It does not do voice identification.** Alexa has voice profiles; Amazon does
  not document whether an MCP add-on receives any of that, so we did not pretend
  to have it. Every authorization decision comes from the access token. If that
  context does exist, this add-on is worse than it needed to be — see
  [`docs/friction-log.md`](docs/friction-log.md).
- **It cannot unsay what was said to it.** `report_symptom` takes the description
  as a plain string, because the user already spoke it aloud and the model already
  heard it. Earshot controls everything downstream of that, and nothing upstream.
- **It is not a compliance product.** Not HIPAA, not audited, not a medical device.
- **The solo window trusts you.** It cannot verify that you are actually alone.
- **`ui://` MCP Apps rendering is untested.** The resource is registered and
  readable, but we have no access to Alexa+ to confirm it renders. It is not on
  the demo path.

## Known findings

This project is a security claim, so its open findings belong in the README
rather than in a tracker nobody reads.

An adversarial review wrote an attacker whose only goal was to make the product
lie, and it won. Each finding is a real executing assertion in
[`test/attack/`](test/attack/), reported by `npm run test:all` under its own
heading — **38 findings, 25 now closed, 13 still failing and named in the output.**
A finding closes because `src/` changed; none of the tests were edited.

The worst one falsified this file's predecessor verbatim. The carrier class had a
public `unseal()` method whose "only callable from this module" was a comment
rather than a modifier: one call, no cast, no import, no capability, and it
ignored classification, so it opened sealed values too. The payload now lives in
a module-scoped `WeakMap` with no property or symbol on the object at all.

**Of the 13 still failing, one is a genuine open limit and should be read as such:**

- **The reveal capabilities are module exports.** Any module inside `src/` that
  imports one holds it. Manufacturing a capability is genuinely blocked — forged
  objects, `Object.create` and `Symbol.for` on the guard name are all refused —
  but "held by X only" describes today's call sites, not an access rule. It is
  mitigated, not closed: a self-test greps the shipped tree and fails the build
  if any module beyond the three legitimate holders so much as mentions a
  capability. Closing it properly needs a module boundary the language does not
  give us.

The other twelve are assertions that cannot pass as written — four require a
composition helper to *succeed* at laundering a sealed value, which is the bug;
three contradict a passing test asserting the opposite of the same call; one ends
in `assert.ok(false)`; one asks for an envelope that costs zero time. They are
left failing and visible rather than quietly deleted, because a test suite that
only contains the assertions the code passes is not evidence of anything. Two
describe real, narrower gaps we chose to state instead of fix: `care_summary`
speaks an item count that is a function of the protected set, and a `toJSON`
returning marker-free plaintext is invisible to a marker scan by construction.

## Licence

MIT. See [LICENSE](LICENSE).
