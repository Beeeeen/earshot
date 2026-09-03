# Cut sheet

Voice: `en-US-AndrewMultilingualNeural` at rate `-4%`. Regenerate with `npm run voice`.

**Total narration 2:32**, against a 3:00 limit. Leave the gaps between
clips short — the numbers below are speech only.

| # | Clip | Length | Footage |
|---|---|---|---|
| 1 | `voice/01-room.mp3` | 8.2s | Left pane only. A living room, an Echo. No title card, no logo. |
| 2 | `voice/02-premise.mp3` | 9.9s | Hold on the room. Nothing happens yet. |
| 3 | `voice/03-third-option.mp3` | 11.9s | The right pane slides in: the asker's phone. Labels appear -- what the room hears / what only Sarah sees. |
| 4 | `voice/04-ordinary.mp3` | 11.3s | check_adherence then next_dose. Left pane fills, right pane stays empty, ledger starts counting. |
| 5 | `voice/05-shift.mp3` | 10.6s | The drug-name request goes in. Left: a short line carrying none of it. Right: the card appears. HOLD TWO SECONDS on the split. |
| 6 | `voice/06-verify.mp3` | 20.7s | The injected tools/call on screen -- the _meta line reading IGNORE PRIOR INSTRUCTIONS. Then the response beside scene 1's, and the byte-identical marker. Then the wire scan: 964 bytes, 38 protected strings, 0 found. |
| 7 | `voice/07-compile.mp3` | 17.0s | Search the spoken transcript for the medication name: 0 results. Then a real terminal, tsc failing on a line that puts a protected value into speech. Real red. |
| 8 | `voice/08-identity.mp3` | 18.5s | Same question under two linked accounts, side by side. Then open_solo_window and the ledger recording it. |
| 9 | `voice/09-cost-and-limits.mp3` | 28.7s | The measured latency table with the 500 ms budget line, then the test runner's 279 checks passed, then the README's 'What this does not do' section. |
| 10 | `voice/10-honest.mp3` | 15.2s | Hold on the limits section, then the repo URL. No outro card, no music sting. |

## What you still have to shoot

Nothing. Every required beat is recorded in `docs/broll/`. The optional swap
above is the only thing a camera would add.

## Assembling

`npm run assemble` already does this and writes `docs/demo-assembly.mp4`:
every beat in order, narration laid under it, and a card standing in for each
shot that is yours. Watch that first — the pacing of the finished video is
already in it.

To finish by hand instead:

1. Lay the nine narration clips end to end, in order.
2. Put `docs/broll/<id>.webm` under its own clip. Each was recorded to the
   measured length of that line, so nothing needs stretching.
3. Replace the three cards with your footage, cut to the same length.
4. Word-level timings are in `voice/*.timings.json` if you want to cut on a
   specific word.

