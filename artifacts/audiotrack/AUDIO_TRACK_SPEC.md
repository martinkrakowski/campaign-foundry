# AudioTrack 1.0 + Phrase Chunker

Contract between speech generation and VE-D9. The video engine never calls `/audio/speech`. It only consumes an `AudioTrack`.

Word-timed cues bind to `words[]`. Phrase boundaries from measured clips are exact. Intra-phrase word times are allocated and marked `timing: "allocated"`.

Schema file: `audiotrack.schema.json`  
Reference chunker: `phrase_chunker.py`

---

## 1. Why this shape

`/audio/speech` returns bytes. VE-D9 wants word intervals. Those are different outputs.

`AudioTrack` is the adapter:

- `audio` is what gets muxed
- `words[]` is what cues attach to
- `phrases[]` records the synthesis units so timings are auditable
- `script_text` vs `spoken_text` stops `$4.2B` / `four point two billion dollars` from breaking cue match

Invariant:

```
words[0].start_s <= ... <= words[-1].end_s
speech_start_s == words[0].start_s
speech_end_s   == words[-1].end_s
duration_s     >= speech_end_s
```

Each word interval is half-open in spirit but stored closed: `start_s < end_s` except for zero-width tokens (dropped, never emitted).

---

## 2. Cue binding (VE-D9 side)

A cue selector is one of:

```json
{ "type": "word_index", "i": 14 }
{ "type": "word_range", "start_i": 14, "end_i": 17 }
{ "type": "spoken_span", "char_start": 80, "char_end": 96 }
{ "type": "script_span", "char_start": 72, "char_end": 78 }
{ "type": "phrase_index", "i": 3 }
```

Resolution order:

1. Exact word index / range
2. `spoken_span` → covering words
3. `script_span` via `script_char_*` on words
4. Phrase fallback only if the cue explicitly asked for a phrase

Time of a resolved range:

```
start_s = words[start_i].start_s
end_s   = words[end_i].end_s
```

Do not bind cues to `duration_s`. Trailing TTS pad is not speech.

If a `script_span` cannot map onto `spoken_text` tokens, emit `CUE_UNBOUND` and skip the cue. Do not guess.

---

## 3. Phrase chunker

### 3.1 Job

```
spoken_text
  → phrases[]
  → one TTS call per phrase
  → measure + trim each clip
  → allocate intra-phrase word times
  → concat with policy gaps
  → AudioTrack
```

Phrase edges are **measured**. That is the precision VE-D9 actually needs for most cuts, captions, and B-roll hits. Word edges inside a phrase are a duration model, not an aligner.

### 3.2 Tokenization

Work on `spoken_text` after a separate normalizer has expanded numbers and abbreviations.

Token = maximal run matching:

```
token        = word | punct | space
word         = letters / digits / internal apostrophes / internal hyphens
               examples: don't, state-of-the-art, 4K, Q3
punct        = one of .?!,:;——–…'"()[]
space        = whitespace
```

Only `word` tokens enter `words[]`. Punctuation affects pause budget and split decisions, then disappears from the word list.

Keep original character offsets into `spoken_text` on every word.

### 3.3 Split policy

Scan tokens left to right. Close a phrase when any rule fires, in this order:

| Priority | Trigger | Close before next word? |
|---|---|---|
| 1 | `.` `?` `!` or `…` | yes, after the punct |
| 2 | `;` or `:` | yes |
| 3 | `,` `—` `--` or parenthetical close, **and** current phrase already has `min_words` | yes |
| 4 | Soft break words (`and`, `but`, `or`, `so`, `then`, `because`, `while`, `which`, `after`, `before`, `when`, `although`, `though`, `if`, `unless`, `until`, `since`) when current phrase ≥ `soft_min_words` and remaining words ≥ `min_words` | yes, **before** the break word |
| 5 | `max_words` or `max_chars` would be exceeded by the next word | yes, before that word |
| 6 | End of text | yes |

Defaults (English narration):

```
min_words        = 4
soft_min_words   = 8
max_words        = 18
max_chars        = 140
min_chars        = 12
```

Never emit an empty phrase. Never split inside a word. If a single word exceeds `max_chars`, emit it alone and warn `MAX_PHRASE_SPLIT`.

Quotes: if a phrase would start with a closing quote or end with an opening quote, pull the quote onto the adjacent phrase.

### 3.4 Why not one-word clips

Per-word TTS destroys F0 continuity and multiplies endpoint calls. Per-sentence TTS is what VE-D9 rejected as a cue grain. Phrases sit in the middle: cheap enough to measure, long enough to sound like speech.

### 3.5 TTS per phrase

Request the same voice, model, and rate for every phrase.

Do not send trailing sentence punctuation as its own clip. Keep it attached to the phrase text so the model can fall.

If the vendor prepends/appends silence, that is handled in trim, not by changing the text.

### 3.6 Measure and trim

For clip `p`:

1. Decode to PCM.
2. Compute RMS envelope, 10 ms hop, 30 ms window.
3. `lead` = first frame ≥ `silence_db` (default −40 dBFS) minus `pad_keep` (20 ms).
4. `trail` = last such frame plus `pad_keep`.
5. `speech_duration_s = trail - lead`.
6. Store `trim_lead_s`, `trim_trail_s`, `audio_duration_s`.

If speech energy never appears, warn `EMPTY_PHRASE_AUDIO` and treat the clip as `gap_before` silence rather than speech.

If `speech_duration_s < 0.35 * audio_duration_s`, warn `SILENCE_HEAVY`.

### 3.7 Inter-phrase gap

`gap_before_s` is **inserted between trimmed clips**, not taken from TTS pad.

```
if phrase i==0:          gap = 0
elif prev ended with .?! : gap = 0.28
elif prev ended with ;:    gap = 0.22
elif prev ended with ,—:   gap = 0.14
else:                      gap = 0.10
```

Clamp to `[0.06, 0.40]`. Do not also keep the untrimmed TTS tail; that double-pauses.

Timeline:

```
cursor = 0
for phrase in phrases:
    cursor += gap_before
    phrase.start_s = cursor
    allocate words inside [cursor, cursor + speech_duration]
    phrase.end_s = cursor + speech_duration
    cursor = phrase.end_s
```

Concat audio in that same order: optional inserted silence + trimmed PCM.

### 3.8 Intra-phrase word allocation

Let phrase words be `w0..wn-1`.

Budget:

```
internal_pause = sum(pause_s(punct_between(wi, wi+1)))
speech_budget  = max(speech_duration_s - internal_pause, n * min_word_s)
```

`pause_s`:

```
,  → 0.08
—  → 0.10
:  → 0.10
;  → 0.12
( ) → 0.04
other → 0
```

Weight of word `w`:

```
weight(w) = 0.35 * chars(w) + 0.65 * syllables(w)
```

English syllable heuristic (good enough for allocation, not linguistics):

```
count vowel groups in lowercase spoken form
trailing silent e does not count unless the word is 1 syllable
minimum 1
```

Then:

```
dur(i) = speech_budget * weight(i) / sum(weights)
dur(i) = clamp(dur(i), min_word_s, max_word_s)
```

`min_word_s = 0.07`, `max_word_s = 0.90`. If clamps break the sum, redistribute leftover proportionally to unclamped words. If still short, scale every word uniformly so they fill `speech_budget`.

Place words left to right, inserting `internal_pause` after a word when the original phrase text has a pause-class punct before the next word.

Mark every such word `timing: "allocated"` and `confidence: 0.55`.  
Mark phrase `timing: "exact"`.

If a later pass runs forced alignment on the concatenated wav + `spoken_text`, overwrite word times, set `timing: "aligned"`, `source: "hybrid"`, and raise word confidence.

### 3.9 Script ↔ spoken map

The normalizer must return:

```
spoken_text
offsets[] : { spoken_start, spoken_end, script_start, script_end }
```

Copy those onto each word as `script_char_*`. Cue selectors that use author text resolve through this table only. No fuzzy string match on the hot path.

If a word has no script span (TTS-only filler such as expanded currency words), leave `script_char_*` null.

---

## 4. Source and confidence

| `source` | Meaning | Typical confidence |
|---|---|---|
| `native` | Vendor returned speech marks | 0.95–0.99 |
| `chunked` | This chunker, no aligner | 0.70–0.85 track / 0.55 words / 0.95 phrases |
| `aligned` | Forced align of known script | 0.85–0.95 |
| `estimated` | One-shot TTS + proportional split of whole file | 0.35–0.50 |
| `hybrid` | Chunker phrase edges + aligner word edges | 0.90 |

VE-D9 may refuse word-locked motion cues when the covering words have `confidence < 0.6`, and fall back to the parent phrase interval.

---

## 5. Worked example

`spoken_text`:

```
The market opened lower after overnight futures sold off, and yields jumped.
```

Chunker output with defaults — the comma fires first (`min_words` already satisfied):

```
P0 The market opened lower after overnight futures sold off,
P1 and yields jumped.
```

`after` is a soft-break word, but only four words precede it and `soft_min_words` is 8, so it does not split there. Short opening clauses stay attached.

Suppose measured trimmed durations are 2.86 s and 1.05 s. Gaps: 0, 0.14 (previous phrase ended on a comma).

```
P0  0.00–2.86
P1  3.00–4.05
speech_end_s = 4.05
```

Words inside P0 share 2.86 s by weight. `overnight` and `futures` get more than `The`. All words are `allocated`. Both phrase intervals are `exact`.

A cue on `yields jumped` is `word_range` over those two tokens. Phrase fallback is all of P1 (`3.00`–`4.05`).

A longer line hits the soft break because `and` arrives after eight words:

```
Overnight futures sold off across every major sector and yields jumped before cash opened.
→ P0 Overnight futures sold off across every major sector
→ P1 and yields jumped before cash opened.
```

---

## 6. Failure modes

| Symptom | Cause | Handle |
|---|---|---|
| Robotic joins | `max_words` too low | raise to 14–18 |
| Cue misses the word | bound to `script_text` after expansion | use `script_char_*` |
| Double pause | kept TTS tail and inserted gap | trim first |
| Runaway phrase | no punct in a paragraph | `max_chars` / `max_words` |
| Empty clip | vendor rejected a short phrase | merge with previous and re-synth |
| Token count ≠ word count | normalizer split a hyphen | treat hyphenated form as one word |

Do not retry the whole creative because one phrase is silence-heavy. Merge that phrase into its neighbor and resynthesize the merge only.

---

## 7. Implementation notes

- Concatenate **trimmed PCM**, then encode once. Do not concat MP3 frames.
- Keep per-phrase wavs in the job scratch dir until mux; they are the debug record when a cue looks early.
- The chunker is deterministic given the same `spoken_text` and config. Cache `phrases[].text` keyed by `(voice, model, rate, text)`.
- Native speech marks short-circuit the chunker: one TTS call, `source: "native"`, `phrases` may be a single span.
- Forced alignment is an optional upgrade pass on the finished wav. It must not be a required dependency of render.

---

## 8. Minimal producer algorithm

```
tokens  = tokenize(spoken_text)
phrases = split(tokens, config)
cursor  = 0
words   = []
pcm     = []

for i, phrase in enumerate(phrases):
    clip = tts(phrase.text)
    pcm_i, lead, trail, speech_dur = trim(clip)
    gap = gap_before(i, phrases)
    pcm.append(silence(gap))
    pcm.append(pcm_i)
    phrase.start_s = cursor + gap
    allocated = allocate(phrase.words, speech_dur, phrase.text)
    shift(allocated, phrase.start_s)
    words.extend(allocated)
    phrase.end_s = phrase.start_s + speech_dur
    cursor = phrase.end_s

write AudioTrack(words, phrases, concat(pcm), source="chunked")
```

`phrase_chunker.py` implements tokenize, split, allocate, and gap policy. TTS and I/O stay outside it so the same functions can be unit-tested without a vendor.
