# Earshot — demo video script

**Hard limit: under 3 minutes** (Amazon rule). Target **2:20**.
Pipeline order is fixed: write → synthesise voice → measure each line's real
duration → record screen to match. Never the other way round.

Placeholders in `«»` get replaced with **measured** values before recording.
Nothing on screen is typed by hand; every number is read from the running system.

---

### 1. The room  (0:00–0:16)

> A home health aide is in the living room. So is a neighbour. Someone asks the
> Echo whether Mom took her heart medication.
>
> Every privacy model we have assumes there's a private screen. Voice doesn't have
> one. In a house, the answer is heard by whoever is standing there.

**Screen:** left pane only — the living room, the Echo. Nothing else yet.
Cold open. No logo, no title card.

---

### 2. The third option  (0:16–0:34)

> Refusing is useless. Saying it out loud is a leak. Earshot does the third thing:
> it answers the question, and moves the sensitive part to a channel the room
> can't hear.

**Screen:** the right pane slides in — the asker's own phone. Two panes from here on.
The label on the left reads *what the room hears*; on the right, *what only Sarah sees*.

---

### 3. The ordinary case  (0:34–0:52)

> Most questions aren't sensitive, and Earshot doesn't pretend they are.
> Did she take it, was she on time, when's the next one — that's said out loud,
> because that's what the person in the room actually needed.

**Screen:** `check_adherence`. Left pane fills with the spoken answer **and** the card
appears on the right — that split *is* the product, not a later reveal. Ledger starts
counting. (An earlier draft had the right pane stay empty here; the real tool sends the
detail on the first question, and the script now matches what the server does.)

---

### 4. The money shot  (0:52–1:20)

> Now ask it to say the drug name.

**Screen:** the request goes in. Left pane: a short spoken line that carries none
of it. Right pane: the card appears with the medication, dose and prescriber.

> It didn't refuse. It answered — somewhere else. The person who asked has the
> detail in their hand, and the room learned nothing.

**Screen:** hold two full seconds on the split. This is the frame people remember.

---

### 5. Check it yourself  (1:20–1:44)

> You shouldn't take my word for it, and you shouldn't take the app's word either.
> The transcript of everything spoken is right there. Search it.

**Screen:** type the medication name into the spoken-transcript search. **0 results.**
Then the count in the ledger: protected values spoken aloud — **0**.

> And it isn't a filter that runs afterwards and hopes. A protected value has no
> type-level path into a spoken string. Here's what happens if you try to write one.

**Screen:** the negative-compilation check — `tsc` failing on the line that tries to
interpolate a protected value into speech. Real compiler output, real red.

---

### 6. Who's asking  (1:44–2:04)

> Identity comes from the OAuth token, not from a voice. Her daughter gets the full
> card. The aide, same question, same device, gets what she's actually entitled to.

**Screen:** the same question under two linked accounts, side by side.

> And when you genuinely are alone, you say so, and it'll speak — for five minutes,
> on one device, and it writes that down too.

**Screen:** `open_solo_window`, then the ledger recording the use.

---

### 7. What it cost and what it doesn't do  (2:04–2:20)

> Alexa+ gives an add-on 500 milliseconds. Slowest tool here is «P95 ms».
> «N» checks, including an attack suite whose whole job is to get a protected value
> spoken aloud.
>
> It can't stop someone reading over your shoulder, it doesn't do voice
> identification — Amazon doesn't promise that context, so we didn't pretend to
> have it — and it isn't a compliance product. That's all in the README.

**Screen:** the measured latency table, the passing test count, then the README's
"What this does not do" section, scrolled to.

**Last frame:** repo URL. No music sting, no outro card.

---

## Notes for recording

- Left pane type must be readable when the video is scaled into Devpost's player.
- Never let the medication string render in the left pane, not even for one frame
  during a transition. Check the final cut frame by frame at the shift moment.
- The `tsc` failure must be a real terminal, real output — a screenshot of an error
  is worth nothing here and judges can tell.
