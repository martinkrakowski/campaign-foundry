"""Deterministic phrase chunker + intra-phrase word allocator.

TTS, decode, and silence trim stay outside this module. Feed spoken_text
in, get phrases and (once durations are known) word intervals out.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Iterable, Sequence


WORD_RE = re.compile(
    r"[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*(?:-[A-Za-z0-9]+)*|[^\sA-Za-z0-9]"
)
VOWEL_GROUP_RE = re.compile(r"[aeiouy]+", re.I)
SOFT_BREAKS = frozenset(
    {
        "and",
        "but",
        "or",
        "so",
        "then",
        "because",
        "while",
        "which",
        "after",
        "before",
        "when",
        "although",
        "though",
        "if",
        "unless",
        "until",
        "since",
    }
)
SENTENCE_END = frozenset({".", "?", "!", "…"})
CLAUSE_END = frozenset({";", ":"})
COMMA_LIKE = frozenset({",", "—", "–", "―"})
CLOSE_QUOTES = frozenset({"\"", "'", "”", "’"})
OPEN_QUOTES = frozenset({"\"", "'", "“", "‘"})


@dataclass(frozen=True)
class ChunkerConfig:
    min_words: int = 4
    soft_min_words: int = 8
    max_words: int = 18
    max_chars: int = 140
    min_word_s: float = 0.07
    max_word_s: float = 0.90
    gap_sentence_s: float = 0.28
    gap_semicolon_s: float = 0.22
    gap_comma_s: float = 0.14
    gap_default_s: float = 0.10
    pause_comma_s: float = 0.08
    pause_dash_s: float = 0.10
    pause_colon_s: float = 0.10
    pause_semicolon_s: float = 0.12


@dataclass(frozen=True)
class Token:
    text: str
    kind: str  # word | punct | other
    start: int
    end: int

    @property
    def lower(self) -> str:
        return self.text.lower()


@dataclass
class PhrasePlan:
    i: int
    text: str
    tokens: list[Token]
    word_tokens: list[Token]
    ends_with: str
    char_start: int
    char_end: int


@dataclass
class AllocatedWord:
    i: int
    text: str
    spoken: str
    start_s: float
    end_s: float
    char_start: int
    char_end: int
    phrase_index: int
    timing: str = "allocated"
    confidence: float = 0.55


def tokenize(spoken_text: str) -> list[Token]:
    tokens: list[Token] = []
    for match in WORD_RE.finditer(spoken_text):
        text = match.group(0)
        if text.isspace():
            continue
        if re.match(r"[A-Za-z0-9]", text):
            kind = "word"
        else:
            kind = "punct"
        tokens.append(Token(text=text, kind=kind, start=match.start(), end=match.end()))
    return tokens


def syllable_count(word: str) -> int:
    cleaned = re.sub(r"[^A-Za-z]", "", word).lower()
    if not cleaned:
        return 1
    groups = VOWEL_GROUP_RE.findall(cleaned)
    count = len(groups)
    if cleaned.endswith("e") and not cleaned.endswith(("le", "ie")) and count > 1:
        count -= 1
    return max(1, count)


def word_weight(word: str) -> float:
    letters = re.sub(r"[^A-Za-z0-9]", "", word)
    return 0.35 * max(1, len(letters)) + 0.65 * syllable_count(word)


def _word_count(tokens: Sequence[Token]) -> int:
    return sum(1 for t in tokens if t.kind == "word")


def _char_len(tokens: Sequence[Token], spoken_text: str) -> int:
    if not tokens:
        return 0
    return tokens[-1].end - tokens[0].start


def _closing_punct(tokens: Sequence[Token]) -> str:
    for token in reversed(tokens):
        if token.kind == "punct" and token.text in (SENTENCE_END | CLAUSE_END | COMMA_LIKE):
            return token.text
        if token.kind == "word":
            return ""
    return ""


def split_phrases(spoken_text: str, config: ChunkerConfig | None = None) -> list[PhrasePlan]:
    config = config or ChunkerConfig()
    tokens = tokenize(spoken_text)
    if not tokens:
        return []

    phrases: list[PhrasePlan] = []
    buf: list[Token] = []

    def flush() -> None:
        if not buf or _word_count(buf) == 0:
            buf.clear()
            return
        start = buf[0].start
        end = buf[-1].end
        word_tokens = [t for t in buf if t.kind == "word"]
        phrases.append(
            PhrasePlan(
                i=len(phrases),
                text=spoken_text[start:end].strip(),
                tokens=list(buf),
                word_tokens=word_tokens,
                ends_with=_closing_punct(buf),
                char_start=start,
                char_end=end,
            )
        )
        buf.clear()

    i = 0
    while i < len(tokens):
        token = tokens[i]
        next_word_would_overflow = False
        if token.kind == "word" and buf:
            prospective = buf + [token]
            next_word_would_overflow = (
                _word_count(prospective) > config.max_words
                or _char_len(prospective, spoken_text) > config.max_chars
            )
            if next_word_would_overflow and _word_count(buf) >= 1:
                flush()

        buf.append(token)

        words_now = _word_count(buf)
        lookahead = tokens[i + 1] if i + 1 < len(tokens) else None

        close = False
        if token.kind == "punct" and token.text in SENTENCE_END:
            close = True
        elif token.kind == "punct" and token.text in CLAUSE_END:
            close = True
        elif (
            token.kind == "punct"
            and token.text in COMMA_LIKE
            and words_now >= config.min_words
        ):
            close = True
        elif (
            token.kind == "word"
            and token.lower in SOFT_BREAKS
            and words_now > 1
        ):
            # Close *before* this soft break if the previous phrase is long
            # enough. We already appended; peel it into the next buffer.
            words_before = words_now - 1
            remaining_words = sum(1 for t in tokens[i:] if t.kind == "word")
            if (
                words_before >= config.soft_min_words
                and remaining_words >= config.min_words
            ):
                soft = buf.pop()
                flush()
                buf.append(soft)

        if close:
            flush()
        i += 1

    flush()

    # Pull a leading close-quote off a phrase onto the previous phrase.
    fixed: list[PhrasePlan] = []
    for phrase in phrases:
        if (
            fixed
            and phrase.tokens
            and phrase.tokens[0].kind == "punct"
            and phrase.tokens[0].text in CLOSE_QUOTES
        ):
            prev = fixed[-1]
            moved = phrase.tokens[0]
            prev.tokens.append(moved)
            prev.char_end = max(prev.char_end, moved.end)
            prev.text = spoken_text[prev.char_start : prev.char_end].strip()
            phrase.tokens = phrase.tokens[1:]
            if not phrase.word_tokens:
                continue
            phrase.char_start = phrase.tokens[0].start
            phrase.text = spoken_text[phrase.char_start : phrase.char_end].strip()
        phrase.i = len(fixed)
        fixed.append(phrase)
    return fixed


def gap_before(index: int, phrases: Sequence[PhrasePlan], config: ChunkerConfig | None = None) -> float:
    config = config or ChunkerConfig()
    if index == 0:
        return 0.0
    ended = phrases[index - 1].ends_with
    if ended in SENTENCE_END:
        gap = config.gap_sentence_s
    elif ended == ";":
        gap = config.gap_semicolon_s
    elif ended in COMMA_LIKE or ended == ":":
        gap = config.gap_comma_s
    else:
        gap = config.gap_default_s
    return max(0.06, min(0.40, gap))


def _punct_pause(punct: str, config: ChunkerConfig) -> float:
    if punct in {","}:
        return config.pause_comma_s
    if punct in COMMA_LIKE:
        return config.pause_dash_s
    if punct == ":":
        return config.pause_colon_s
    if punct == ";":
        return config.pause_semicolon_s
    return 0.0


def _pauses_between_words(phrase: PhrasePlan, config: ChunkerConfig) -> list[float]:
    """Pause after word k, before word k+1."""
    pauses = [0.0] * max(0, len(phrase.word_tokens) - 1)
    word_pos = {id(tok): n for n, tok in enumerate(phrase.word_tokens)}
    last_word_n: int | None = None
    pending = 0.0
    for token in phrase.tokens:
        if token.kind == "word":
            n = word_pos[id(token)]
            if last_word_n is not None and n - 1 == last_word_n:
                pauses[last_word_n] = pending
            pending = 0.0
            last_word_n = n
        else:
            pending = max(pending, _punct_pause(token.text, config))
    return pauses


def allocate_phrase(
    phrase: PhrasePlan,
    speech_duration_s: float,
    word_index_start: int,
    config: ChunkerConfig | None = None,
) -> list[AllocatedWord]:
    config = config or ChunkerConfig()
    words = phrase.word_tokens
    if not words:
        return []
    pauses = _pauses_between_words(phrase, config)
    pause_total = sum(pauses)
    n = len(words)
    budget = max(speech_duration_s - pause_total, n * config.min_word_s)
    weights = [word_weight(w.text) for w in words]
    raw = [budget * w / sum(weights) for w in weights]

    durs: list[float] = []
    free: list[int] = []
    locked_sum = 0.0
    for i, dur in enumerate(raw):
        clamped = min(config.max_word_s, max(config.min_word_s, dur))
        durs.append(clamped)
        if clamped == dur:
            free.append(i)
        else:
            locked_sum += clamped

    leftover = budget - sum(durs)
    if abs(leftover) > 1e-6 and free:
        free_weight = sum(weights[i] for i in free)
        for i in free:
            durs[i] += leftover * (weights[i] / free_weight)

    # Final scale so words + pauses fill speech_duration when possible.
    filled = sum(durs) + pause_total
    if filled > 0 and speech_duration_s > 0:
        scale = speech_duration_s / filled
        durs = [d * scale for d in durs]
        pauses = [p * scale for p in pauses]

    out: list[AllocatedWord] = []
    t = 0.0
    for i, word in enumerate(words):
        start = t
        end = t + durs[i]
        out.append(
            AllocatedWord(
                i=word_index_start + i,
                text=word.text,
                spoken=word.text,
                start_s=round(start, 4),
                end_s=round(end, 4),
                char_start=word.start,
                char_end=word.end,
                phrase_index=phrase.i,
            )
        )
        t = end
        if i < len(pauses):
            t += pauses[i]
    if out:
        out[-1].end_s = round(speech_duration_s, 4)
    return out


def place_on_timeline(
    phrases: Sequence[PhrasePlan],
    speech_durations: Sequence[float],
    config: ChunkerConfig | None = None,
) -> tuple[list[AllocatedWord], list[dict]]:
    """Shift per-phrase allocations onto a global timeline."""
    config = config or ChunkerConfig()
    if len(phrases) != len(speech_durations):
        raise ValueError("speech_durations must match phrases")

    words: list[AllocatedWord] = []
    phrase_rows: list[dict] = []
    cursor = 0.0
    for phrase, dur in zip(phrases, speech_durations):
        gap = gap_before(phrase.i, phrases, config)
        start = cursor + gap
        allocated = allocate_phrase(phrase, dur, word_index_start=len(words), config=config)
        for word in allocated:
            word.start_s = round(word.start_s + start, 4)
            word.end_s = round(word.end_s + start, 4)
        words.extend(allocated)
        end = start + dur
        phrase_rows.append(
            {
                "i": phrase.i,
                "text": phrase.text,
                "word_start": allocated[0].i if allocated else len(words),
                "word_end": allocated[-1].i if allocated else len(words),
                "start_s": round(start, 4),
                "end_s": round(end, 4),
                "audio_duration_s": None,
                "speech_duration_s": round(dur, 4),
                "gap_before_s": round(gap, 4),
                "timing": "exact",
            }
        )
        cursor = end
    return words, phrase_rows


def plan_to_json(spoken_text: str, speech_durations: Sequence[float] | None = None) -> dict:
    phrases = split_phrases(spoken_text)
    payload = {
        "spoken_text": spoken_text,
        "phrases": [
            {
                "i": p.i,
                "text": p.text,
                "ends_with": p.ends_with,
                "word_count": len(p.word_tokens),
                "words": [t.text for t in p.word_tokens],
            }
            for p in phrases
        ],
    }
    if speech_durations is not None:
        words, phrase_rows = place_on_timeline(phrases, speech_durations)
        payload["phrases"] = phrase_rows
        payload["words"] = [asdict(w) for w in words]
        payload["speech_end_s"] = words[-1].end_s if words else 0.0
    return payload


if __name__ == "__main__":
    demo = (
        "The market opened lower after overnight futures sold off, "
        "and yields jumped."
    )
    print(json.dumps(plan_to_json(demo, [2.86, 1.05]), indent=2))
    long_demo = (
        "Overnight futures sold off across every major sector and yields jumped "
        "before cash opened."
    )
    print(json.dumps(plan_to_json(long_demo), indent=2))
