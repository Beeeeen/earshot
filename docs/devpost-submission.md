# Earshot — Devpost submission

> Every number here is measured, not estimated. Reconciled against the built
> system on 2026-09-04: `npm run test:all` and `npm run demo`.

**Alexa+ track.** Mini challenge: Open Source.

---

## Tagline

Ask Alexa how your mother is doing, in a room that has other people in it — and
she is one of them, and the rules are hers.

---

## Inspiration

An Echo in a living room has a property no phone has: everyone in the room hears
the answer.

That sounds obvious until you try to build anything for care. A daughter asks
whether her mother took her heart medication. Standing in that room are a home
health aide, sometimes a neighbour, sometimes a contractor fixing the boiler. The
honest answer to that question contains a diagnosis.

Every privacy model we have was designed for a screen you hold at an angle
nobody else can see. Voice deletes that assumption, and the tools built on top of
it inherit a choice between two bad options. Refuse, and the assistant is useless
for exactly the household that needed it most. Answer, and you have read someone's
medical history aloud to whoever was standing there.

The obvious reply is that she should use a phone instead. That reply is why this
problem stays unsolved: the households that most need a voice assistant are the
ones where somebody cannot work a phone. Voice is not the convenient option here,
it is the only one, and telling them to use a screen is telling them to go away.

The thing that started this project was noticing that refusing and disclosing are
not the only two options, and that the third one exists only because the assistant
can reach you on more than one channel at once.

## What it does

Earshot is a self-hosted MCP server that Alexa+ connects to as an add-on. It holds
a household's care information — medication schedules, adherence, symptoms, and who
is allowed to know what — and it answers questions about all of it.

What it never does is say a protected value out loud.

Ask whether she took her medication and it says yes, on time, next one at six.
That is what the person in the room actually needed, and none of it is sensitive.
Ask what she is taking, and it does not refuse. It answers on the asker's own
device — the drug, the dose, the prescriber — pulled with the asker's own token
from `/inbox`, a companion surface, not the Alexa+ card itself (that card renders
a masked receipt and nothing more; see the README). The spoken channel carries a
sentence that contains none of it.

The room learns that something was sent. It does not learn what.

**The part we are actually claiming is narrower than it looks, and we want to say
so before a judge does.** Splitting one answer between a speaker and a phone is
patented three times over — Amazon's own US 10,803,859 B1 (priority 2017), plus
Microsoft and IBM. Microsoft's worked example is literally *"check your phone for
details about your 2 o'clock appointment."* We are not the first to think of
this; we may be the first to ship it.

What none of that prior art decides is **whose policy governs.** All of it
protects the asker or the account holder. In care, the person the data is about
is neither — Margaret is a third party to her own medical record, and she is the
other person in the room. In Earshot every rule is hers: every grant carries
`grantedBy`, and every seeded grant is `grantedBy: MARGARET`. Sarah may hear
everything; Dana the aide may know what to give and when, but not why and not who
prescribed it; the neighbour has no row at all. And Margaret receives the whole
ledger about herself, including the requests refused on her behalf while she was
sitting there.

It is also not "send a notification instead." A notification is what you do when
you have given up on answering. Earshot answers out loud — "yes, on time, next
one at six" is the actual answer to the actual question — and moves only the part
that cannot be said. Most questions never touch the private channel at all.

**You can check that claim in about fifteen seconds.** Everything Earshot has
spoken aloud is kept verbatim and is searchable in the demo. Search it for the
medication name and there are no results, because there was never a code path that
could have put it there.

That last part is the design, not a promise. A protected value in Earshot has a
type that has no route into a spoken string — no template literal, no
concatenation, no `toString`. Trying to write the leak is a compile error, and the
repository contains a check that fails the build if that stops being true. A filter
that inspects text on its way out is theatre: you are always one unanticipated
format string from defeating it. A leak should be impossible to *express*.

Three more things fall out of the same design:

- **Identity comes from the OAuth token, not from a voice.** Her daughter and the
  visiting aide ask the same question on the same device and get different
  answers, because they linked different accounts, against an explicit grant table.
- **When you really are alone, you can say so.** A solo window lasts five minutes,
  covers one device and one asker, expires on its own, and is written into the
  ledger every time it is used.
- **There is a ledger.** What was spoken, what was moved to a private channel,
  what was refused, and the count of protected values ever spoken aloud, which
  reads zero.

## How we built it

TypeScript on Node, the Model Context Protocol TypeScript SDK, Streamable HTTP,
OAuth 2.1 with PKCE. `@modelcontextprotocol/sdk@1.30.0` negotiates
`2025-11-25` as its latest protocol version, which is exactly the minimum Alexa+
requires, so the protocol layer is the SDK's rather than ours.

Three decisions did most of the work.

**The spoken channel is a type, not a convention.** Every tool returns a
discriminated result with a `spoken` field and an optional `private` payload. The
`spoken` string can only be built by a constructor that refuses protected inputs at
compile time. This is the whole guarantee, and it is why the guarantee is checkable
by someone who assumes we are lying: they can read one file.

**The 500 ms budget shaped the architecture before it shaped the code.** Alexa+
requires a round trip under half a second, and the documentation does not say
whether that covers the network hop. We assumed it does, which leaves the handler
very little, which is why the data layer is in-process with no external round
trips. Measured: the server's own handler time stays **under 10 ms** across all eight tools, and not one call in roughly 900 went over budget. Worst client-observed p95 is 11-14 ms on loopback depending on the run — which does not include Amazon's network, so the server-side number is the one that transfers.

**Refusals return, they don't throw.** A thrown error becomes a spoken apology,
which is the worst possible outcome on a device with no screen. Every guard returns
the reason plus the legal alternative, so the model recovers on the next turn
instead of dead-ending. This turned out to matter more on voice than it did on the
web, because a person listening cannot scroll back.

## Challenges we ran into

**We could not find out what the server actually receives.** The add-ons
documentation links an authentication page that returns 404, and nothing else
enumerates the fields on an inbound tool call. We wanted per-speaker
personalisation — Alexa has voice profiles, and a care product is obviously better
if it knows which household member is talking. We could not confirm that Alexa+
forwards any of it to an MCP server, so we built the entire authorization model on
the access token, which is the one identity we know is real. That is the largest
single compromise in the project and it came from a missing page, not a technical
limit.

**Making the guarantee true rather than plausible.** We wrote the attacker, and it won several times.

The worst one falsified this project's own documentation, verbatim. The module
holding the guarantee claimed that no expression in TypeScript or JavaScript
recovers a protected value's plaintext without importing one of two audited
reveal functions. That was false: the carrier class had a public `unseal()`
method whose "only callable from this module" was a comment rather than a
modifier. One call, no cast, no import, no capability — and it ignored
classification, so it opened sealed values too, and its output carried no taint
marker, so every downstream tripwire waved it through. The `#private` field was
genuinely sealed. The door beside it was unlocked.

Two more had the same shape, which turned out to be the shape worth learning.
A composition helper accepted a `sealed` value and returned a well-formed
`private` one, so a chain of individually-permitted operations relabelled its own
input and walked around the check — and the ledger recorded the result under the
wrong category, so the audit trail agreed with the attacker. And the ledger tool
itself re-labelled every row it built as one category, then gated on "may this
person ask?" rather than "may this person receive this category?", which handed a
visiting aide the names of the exact categories she is denied.

None of those were found by reading the code, and none by testing that the
features work. They were found by writing something whose only goal was to make
the product lie. Twenty-five of the thirty-eight are closed, and the tests were not touched to close them — a finding shuts because the code changed. The thirteen that remain stay in the output with their names on, because a suite containing only the assertions the code passes is not evidence of anything. One of them is a real limit we could not close: any module that imports a reveal capability holds it, and the language gives us no boundary that would prevent it, so instead a self-test greps the shipped tree and fails the build if any module beyond the three legitimate holders mentions one. That is a mitigation, and the README calls it a mitigation.

**The solo window nearly shipped as a backdoor. It is meant to cover one device for five minutes, and "this device" is the transport's session id — but nothing forced that id to exist. A transport that supplied none would have opened a window covering *every* device at once, silently, which is the exact opposite of the feature. It now fails closed: it refuses out loud and writes a denied row. The lesson is that an escape hatch is the most dangerous code in a project like this, because it is the one place where the guarantee is deliberately switched off, and it deserves more suspicion than the guarantee itself.**

## Accomplishments that we're proud of

A privacy tool that states its own limits in its README rather than in a footnote.
It cannot stop someone reading over your shoulder. It does not do voice
identification. It is not a compliance product. Saying so is not modesty — a
security claim you cannot check is worth less than a smaller one you can.

And an attack suite whose entire job is to get a protected value spoken aloud,
where a failure is a finding rather than a broken test — reported by the test
runner as an open finding rather than quietly excluded from a headline number.
322 checks pass; 38 tracked assertions across 16 named findings, 25 now closed and 13 still failing and named in the runner's own output (four reasons, explained in the README: they require the bug to succeed, they contradict a passing test, one is a hard `assert.ok(false)`, and two describe accepted narrower gaps we chose to state rather than fix).

## What we learned

That the interesting constraints of a platform are usually the ones you would have
called limitations. Voice has no private surface and no scrollback, and both of
those turned into design pressure that produced a better product than a screen
would have. The 500 ms ceiling did the same thing: it removed the option of a
network call in the hot path, which removed the option of the sloppy architecture.

## What's next

Per-speaker grants, the moment Amazon documents what an add-on receives. A signed
audit export, which is the artefact a care agency needs before this goes anywhere
near a real household. And a second private channel for people whose asker has no
phone, which is a large fraction of the population this is actually for.
