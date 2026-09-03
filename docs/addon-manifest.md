# Alexa+ add-on manifest copy

Hand-written, not scaffolder output. `alexa-ai new mcp` generates these from the
tool schemas and the result is plausible and generic; our own friction log
complains that nothing prompts you to rewrite them, so rewriting them is the
minimum we owe that complaint.

Move into `addon-package/addon.json` at deploy time.

---

## shortDescription (max 123 chars)

> Care answers you can ask out loud, without the room hearing the private part.

*(74 chars.)*

---

## fullDescription (max 4000 chars)

> Ask Alexa how your mother is doing, in a room that has other people in it.
>
> Earshot answers care questions out loud — whether a dose was taken, whether it
> was on time, when the next one is due — and sends the part that shouldn't be
> said aloud to your own device instead. Medication names, doses, diagnoses and
> prescribers arrive on your phone. They are never spoken.
>
> That distinction exists because a voice assistant has no private screen. A
> home health aide, a neighbour, a visiting grandchild — anyone standing there
> hears whatever Alexa says. Most care questions are perfectly fine to answer
> out loud, and Earshot answers them. The few that aren't get moved rather than
> refused, so you still get the answer.
>
> Everyone who can see a person's information links their own account, and each
> gets what they've been granted — a daughter and a visiting aide can ask the
> same question on the same device and get different answers. You can ask
> "who can see Mum's information?" out loud any time; that one is deliberately
> spoken, because who holds access is exactly the thing that should be said in
> the room.
>
> When you genuinely are alone and want something read out, you can say so. That
> lasts five minutes, covers the one device you said it on, and is written into
> the disclosure record along with everything else.
>
> Earshot keeps a plain record of what was said aloud, what was sent privately,
> and what was declined. You can read it, and so can the person being cared for.
>
> Earshot is not a medical device and is not a substitute for talking to a
> clinician. It does not diagnose, advise, or make decisions about treatment.

---

## examplePhrases (3–4 items, max 200 chars each)

1. > Alexa, did Mum take her pills today?
2. > Alexa, when is her next dose?
3. > Alexa, who can see Mum's information?
4. > Alexa, tell Sarah my ankles are swollen again.

Chosen so the first one is the question people actually ask, the third
demonstrates the transparency tool, and the fourth shows the person being cared
for using it themselves rather than only being discussed.

---

## Still blocked — these need real HTTPS URLs before `alexa-ai deploy`

| Field | Status |
|---|---|
| `privacyPolicyUrl` | **Needed.** Must be a live HTTPS page. |
| `termsOfUseUrl` | **Needed.** Must be a live HTTPS page. |

Both can be pages on the project's GitHub Pages site once the repo is public.
They are a hard requirement of the manifest — `alexa-ai deploy` validates them —
so they block deployment but not the hackathon submission itself, which requires
a repo, a video and a description rather than a certified add-on.
