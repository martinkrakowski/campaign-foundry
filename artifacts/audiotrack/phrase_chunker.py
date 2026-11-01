"""Deterministic phrase chunker + intra-phrase word allocator.

TTS, decode, and silence trim stay outside this module. Feed spoken_text
in, get phrases and (once durations are known) word intervals out.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Sequence


WORD_CHAR = r"[^\W_]"
WORD_RE = re.compile(
    rf"{WORD_CHAR}+(?:['’]{WORD_CHAR}+)*(?:-(?!-){WORD_CHAR}+(?:['’]{WORD_CHAR}+)*)*|--|\S"
)
VOWEL_GROUP_RE = re.compile(
    r"[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+",
    re.I,
)
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
COMMA_LIKE = frozenset({",", "--", "—", "–", "―"})
DASHES = frozenset({"--", "—", "–", "―", "-"})
PARENS = frozenset({"(", ")"})
CURLY_OPEN_QUOTES = frozenset({"“", "‘"})
CURLY_CLOSE_QUOTES = frozenset({"”", "’"})
STRAIGHT_QUOTES = frozenset({"\"", "'"})


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
    pause_paren_s: float = 0.04


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
        kind = "word" if text[0].isalnum() else "punct"
        tokens.append(Token(text=text, kind=kind, start=match.start(), end=match.end()))
    return tokens


def syllable_count(word: str) -> int:
    cleaned = "".join(ch for ch in word.lower() if ch.isalpha())
    if not cleaned:
        return 1
    groups = VOWEL_GROUP_RE.findall(cleaned)
    count = len(groups)
    # A trailing "e" is usually silent ("late" -> 1); keep it for "le"/"ie"
    # endings ("table" -> 2) and for single-vowel-group words. This applies to
    # any spelling, accented or not: "café" ends in é, while "naïve" and
    # "façade" end in a silent "e".
    if cleaned.endswith("e") and not cleaned.endswith(("le", "ie")) and count > 1:
        count -= 1
    return max(1, count)


def word_weight(word: str) -> float:
    letters = "".join(ch for ch in word if ch.isalnum())
    return 0.35 * max(1, len(letters)) + 0.65 * syllable_count(word)


def _word_count(tokens: Sequence[Token]) -> int:
    return sum(1 for t in tokens if t.kind == "word")


def _char_len(tokens: Sequence[Token], spoken_text: str) -> int:
    if not tokens:
        return 0
    return tokens[-1].end - tokens[0].start


def _is_opening_quote(token: Token, spoken_text: str) -> bool:
    if token.text in CURLY_OPEN_QUOTES:
        return True
    if token.text in CURLY_CLOSE_QUOTES:
        return False
    if token.text not in STRAIGHT_QUOTES:
        return False
    prev = spoken_text[token.start - 1] if token.start > 0 else None
    if prev is None:
        preceded = token.start == 0
    else:
        preceded = prev.isspace() or prev in "([—–-"
    followed = token.end < len(spoken_text) and not spoken_text[token.end].isspace()
    return preceded and followed


def _is_closing_quote(token: Token, spoken_text: str) -> bool:
    if token.text in CURLY_CLOSE_QUOTES:
        return True
    if token.text in CURLY_OPEN_QUOTES:
        return False
    if token.text not in STRAIGHT_QUOTES:
        return False
    if _is_opening_quote(token, spoken_text):
        return False
    return token.start > 0 and not spoken_text[token.start - 1].isspace()


def _closing_punct(tokens: Sequence[Token]) -> str:
    for token in reversed(tokens):
        if token.kind == "word":
            return ""
        if token.kind == "punct" and token.text in (SENTENCE_END | CLAUSE_END | COMMA_LIKE):
            return token.text
        # Trailing closing quotes and ")" are decor, not phrase-enders.
    return ""


def _flush_buffer(
    buf: list[Token],
    phrases: list[PhrasePlan],
    spoken_text: str,
) -> None:
    """Emit the pending buffer as a phrase (when it holds words) and clear it."""
    if buf and _word_count(buf) > 0:
        phrases.append(_make_phrase(len(phrases), buf, spoken_text))
    buf.clear()


def _break_overflow(
    buf: Sequence[Token],
    token: Token,
    config: ChunkerConfig,
    spoken_text: str,
) -> bool:
    """True when appending token would breach max_words or max_chars."""
    if token.kind != "word" or _word_count(buf) < 1:
        return False
    prospective = list(buf) + [token]
    return (
        _word_count(prospective) > config.max_words
        or _char_len(prospective, spoken_text) > config.max_chars
    )


def _is_sentence_end_punct(token: Token) -> bool:
    return token.kind == "punct" and token.text in (SENTENCE_END | CLAUSE_END)


def _is_comma_like_close(token: Token, words_now: int, config: ChunkerConfig) -> bool:
    return (
        token.kind == "punct"
        and (token.text in COMMA_LIKE or token.text == ")")
        and words_now >= config.min_words
    )


def _apply_soft_break(
    token: Token,
    idx: int,
    tokens: Sequence[Token],
    buf: list[Token],
    phrases: list[PhrasePlan],
    config: ChunkerConfig,
    spoken_text: str,
) -> bool:
    """Split before a soft-break word when both sides carry enough words."""
    if token.kind != "word" or token.lower not in SOFT_BREAKS:
        return False
    words_now = _word_count(buf)
    if words_now <= 1:
        return False
    if words_now - 1 < config.soft_min_words:
        return False
    remaining_words = sum(1 for t in tokens[idx:] if t.kind == "word")
    if remaining_words < config.min_words:
        return False
    break_word = buf.pop()
    _flush_buffer(buf, phrases, spoken_text)
    buf.append(break_word)
    return True


def split_phrases(spoken_text: str, config: ChunkerConfig | None = None) -> list[PhrasePlan]:
    config = config or ChunkerConfig()
    tokens = tokenize(spoken_text)
    if not tokens:
        return []

    phrases: list[PhrasePlan] = []
    buf: list[Token] = []

    idx = 0
    while idx < len(tokens):
        token = tokens[idx]
        if _break_overflow(buf, token, config, spoken_text):
            _flush_buffer(buf, phrases, spoken_text)
        buf.append(token)
        words_now = _word_count(buf)

        close = _is_sentence_end_punct(token) or _is_comma_like_close(
            token, words_now, config
        )
        if close:
            idx = _absorb_closing_run(tokens, idx, buf, spoken_text)
            _flush_buffer(buf, phrases, spoken_text)
        else:
            _apply_soft_break(token, idx, tokens, buf, phrases, config, spoken_text)
        idx += 1

    _flush_buffer(buf, phrases, spoken_text)

    return _repair_boundary_quotes(phrases, spoken_text)


def _make_phrase(i: int, toks: Sequence[Token], spoken_text: str) -> PhrasePlan:
    start = toks[0].start
    end = toks[-1].end
    word_tokens = [t for t in toks if t.kind == "word"]
    return PhrasePlan(
        i=i,
        text=spoken_text[start:end].strip(),
        tokens=list(toks),
        word_tokens=word_tokens,
        ends_with=_closing_punct(toks),
        char_start=start,
        char_end=end,
    )


def _absorb_closing_run(
    tokens: Sequence[Token],
    idx: int,
    buf: list[Token],
    spoken_text: str,
) -> int:
    """Extend the closing phrase with adjacent sentence-end, ")", or closing
    quote tokens so multi-char enders ("Wait?!", "Wait...") stay intact."""
    while idx + 1 < len(tokens):
        nxt = tokens[idx + 1]
        if nxt.start != buf[-1].end:
            break
        if nxt.text in SENTENCE_END or nxt.text == ")" or _is_closing_quote(nxt, spoken_text):
            idx += 1
            buf.append(nxt)
            continue
        break
    return idx


def _repair_boundary_quotes(phrases: list[PhrasePlan], spoken_text: str) -> list[PhrasePlan]:
    """Move boundary quotes so no phrase starts with a closing quote or ends
    with an opening quote, then rebuild the affected phrases."""
    tok_lists: list[list[Token]] = [list(p.tokens) for p in phrases]

    for j in range(1, len(tok_lists)):
        if tok_lists[j] and _is_closing_quote(tok_lists[j][0], spoken_text):
            moved = tok_lists[j].pop(0)
            tok_lists[j - 1].append(moved)

    for j in range(len(tok_lists) - 1):
        if tok_lists[j] and _is_opening_quote(tok_lists[j][-1], spoken_text):
            moved = tok_lists[j].pop()
            tok_lists[j + 1].insert(0, moved)

    kept: list[list[Token]] = [toks for toks in tok_lists if toks and _word_count(toks) > 0]
    return [_make_phrase(i, toks, spoken_text) for i, toks in enumerate(kept)]


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
    if punct == ",":
        return config.pause_comma_s
    if punct in DASHES:
        return config.pause_dash_s
    if punct == ":":
        return config.pause_colon_s
    if punct == ";":
        return config.pause_semicolon_s
    if punct in PARENS:
        return config.pause_paren_s
    return 0.0


def _internal_pauses(
    word_tokens: Sequence[Token],
    tokens: Sequence[Token],
    config: ChunkerConfig,
) -> list[float]:
    """Pause after word k, before word k+1."""
    pauses = [0.0] * max(0, len(word_tokens) - 1)
    word_pos = {id(tok): n for n, tok in enumerate(word_tokens)}
    last_word_n: int | None = None
    pending = 0.0
    for token in tokens:
        if token.kind != "word":
            pending = max(pending, _punct_pause(token.text, config))
            continue
        n = word_pos.get(id(token))
        if n is None:
            continue
        if last_word_n is not None and n - 1 == last_word_n:
            pauses[last_word_n] = pending
        pending = 0.0
        last_word_n = n
    return pauses


def _solve_waterfill(
    weights: Sequence[float],
    budget: float,
    min_w: float,
    max_w: float,
) -> list[float]:
    """Distribute budget across weights so each share lands in [min_w, max_w].

    If the raw proportional split already fits, return it exactly (this keeps
    the spec's worked-example floats reproducible). Otherwise binary-search
    the scaling factor alpha so that sum(clamp(alpha * w)) fills the budget.
    """
    total = sum(weights)
    raw = [budget * (w / total) for w in weights]
    if all(min_w <= d <= max_w for d in raw):
        return raw

    lo = min_w / max(weights)
    hi = max_w / min(weights)
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        clamped_sum = sum(min(max_w, max(min_w, mid * w)) for w in weights)
        if clamped_sum < budget:
            lo = mid
        else:
            hi = mid
    alpha = 0.5 * (lo + hi)
    return [min(max_w, max(min_w, alpha * w)) for w in weights]


def _build_words(
    words: Sequence[Token],
    durs: Sequence[float],
    pauses: Sequence[float],
    word_index_start: int,
    phrase_index: int,
) -> list[AllocatedWord]:
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
                phrase_index=phrase_index,
            )
        )
        t = end
        if i < len(pauses):
            t += pauses[i]
    return out


def _short_clip(
    weights: Sequence[float],
    speech_duration_s: float,
    pause_count: int,
) -> tuple[list[float], list[float], bool, bool]:
    """speech_duration_s < n * min_word_s: no room for pauses; scale words
    proportionally across the shortened clip."""
    w_sum = sum(weights)
    durs = [speech_duration_s * (w / w_sum) for w in weights]
    return durs, [0.0] * pause_count, True, False


def _scale_pauses(
    weights: Sequence[float],
    raw_pauses: list[float],
    speech_duration_s: float,
    config: ChunkerConfig,
) -> tuple[list[float], list[float], bool, bool]:
    """min_total <= speech_duration_s <= max_total + pause_sum: compress pauses
    first when words would fall under the floor, then water-fill."""
    pause_sum = sum(raw_pauses)
    min_total = len(weights) * config.min_word_s
    if speech_duration_s - pause_sum < min_total and pause_sum > 0:
        scale = (speech_duration_s - min_total) / pause_sum
        pauses = [p * scale for p in raw_pauses]
        budget = min_total
    else:
        pauses = list(raw_pauses)
        budget = speech_duration_s - pause_sum
    durs = _solve_waterfill(weights, budget, config.min_word_s, config.max_word_s)
    return durs, pauses, False, False


def _clamp_words(
    raw_pauses: list[float],
    speech_duration_s: float,
    max_total: float,
    pause_sum: float,
    config: ChunkerConfig,
    n: int,
) -> tuple[list[float], list[float], bool, bool]:
    """speech_duration_s > max_total + pause_sum: cap every word at max_word_s
    and pour the residual into inter-word pauses (or trailing silence for a
    single word)."""
    durs = [config.max_word_s] * n
    residual = speech_duration_s - max_total - pause_sum
    if n > 1:
        pauses = [p + residual / (n - 1) for p in raw_pauses]
    else:
        pauses = list(raw_pauses)
    return durs, pauses, True, n == 1


def _resolve_timings(
    weights: Sequence[float],
    raw_pauses: list[float],
    speech_duration_s: float,
    config: ChunkerConfig,
    n: int,
) -> tuple[list[float], list[float], bool, bool]:
    """Pick the allocation regime: (durations, pauses, clamped, trailing silence)."""
    pause_sum = sum(raw_pauses)
    min_total = n * config.min_word_s
    max_total = n * config.max_word_s
    if speech_duration_s < min_total:
        return _short_clip(weights, speech_duration_s, len(raw_pauses))
    if speech_duration_s <= max_total + pause_sum:
        return _scale_pauses(weights, raw_pauses, speech_duration_s, config)
    return _clamp_words(raw_pauses, speech_duration_s, max_total, pause_sum, config, n)


def allocate_phrase(
    phrase: PhrasePlan,
    speech_duration_s: float,
    word_index_start: int = 0,
    config: ChunkerConfig | None = None,
    warnings_out: list[dict] | None = None,
) -> list[AllocatedWord]:
    config = config or ChunkerConfig()
    if speech_duration_s < 0:
        raise ValueError("speech_duration_s must be >= 0")
    words = phrase.word_tokens
    if not words:
        return []
    if speech_duration_s == 0:
        if warnings_out is not None:
            warnings_out.append(
                {
                    "code": "EMPTY_PHRASE_AUDIO",
                    "message": "Phrase has 0s speech duration; word timings omitted.",
                    "phrase_index": phrase.i,
                }
            )
        return []

    n = len(words)
    weights = [word_weight(w.text) for w in words]
    raw_pauses = _internal_pauses(words, phrase.tokens, config)
    durs, pauses, clamped, trailing_silence = _resolve_timings(
        weights, raw_pauses, speech_duration_s, config, n
    )
    if clamped and warnings_out is not None:
        warnings_out.append(
            {
                "code": "RATE_CLAMPED",
                "message": f"Phrase {phrase.i} speech duration is outside the "
                f"[{n} * min_word_s, {n} * max_word_s + pauses] band; word "
                "durations were clamped.",
                "phrase_index": phrase.i,
            }
        )

    out = _build_words(words, durs, pauses, word_index_start, phrase.i)
    if out and not trailing_silence:
        out[-1].end_s = round(speech_duration_s, 4)
    return out


def _audio_duration_for(
    audio_durations: Sequence[float] | None,
    pos: int,
    default: float,
) -> float:
    if audio_durations is None:
        return default
    return float(audio_durations[pos])


def _phrase_word_bounds(
    allocated: Sequence[AllocatedWord],
    words: Sequence[AllocatedWord],
) -> tuple[int, int]:
    if allocated:
        return allocated[0].i, allocated[-1].i
    return len(words), len(words)


def place_on_timeline(
    phrases: Sequence[PhrasePlan],
    speech_durations: Sequence[float],
    audio_durations: Sequence[float] | None = None,
    config: ChunkerConfig | None = None,
) -> tuple[list[AllocatedWord], list[dict], list[dict]]:
    """Shift per-phrase allocations onto a global timeline.

    audio_durations are the measured clip lengths before concat. When omitted,
    each phrase's audio duration defaults to its speech duration. Returns
    (words, phrase_rows, warnings) where warnings carries SILENCE_HEAVY,
    EMPTY_PHRASE_AUDIO, and RATE_CLAMPED entries with phrase_index set.
    """
    config = config or ChunkerConfig()
    if len(phrases) != len(speech_durations):
        raise ValueError("speech_durations must match phrases")
    if audio_durations is not None and len(audio_durations) != len(phrases):
        raise ValueError("audio_durations must match phrases")

    warnings: list[dict] = []
    words: list[AllocatedWord] = []
    phrase_rows: list[dict] = []
    cursor = 0.0
    for pos, (phrase, dur) in enumerate(zip(phrases, speech_durations)):
        if dur < 0:
            raise ValueError("speech_durations must be >= 0")
        if phrase.word_tokens and dur == 0:
            raise ValueError(
                f"Phrase {phrase.i} has words but zero speech duration"
            )
        audio_dur = _audio_duration_for(audio_durations, pos, dur)
        if audio_dur < 0:
            raise ValueError("audio_durations must be >= 0")
        if audio_dur > 0 and dur < 0.35 * audio_dur:
            warnings.append(
                {
                    "code": "SILENCE_HEAVY",
                    "message": f"Phrase {phrase.i} speech is under 35% of its clip audio duration.",
                    "phrase_index": phrase.i,
                }
            )
        gap = gap_before(phrase.i, phrases, config)
        start = cursor + gap
        allocated = allocate_phrase(
            phrase, dur, word_index_start=len(words), config=config, warnings_out=warnings
        )
        for word in allocated:
            word.start_s = round(word.start_s + start, 4)
            word.end_s = round(word.end_s + start, 4)
        words.extend(allocated)
        end = start + dur
        word_start, word_end = _phrase_word_bounds(allocated, words)
        phrase_rows.append(
            {
                "i": phrase.i,
                "text": phrase.text,
                "word_start": word_start,
                "word_end": word_end,
                "start_s": round(start, 4),
                "end_s": round(end, 4),
                "audio_duration_s": round(audio_dur, 4),
                "speech_duration_s": round(dur, 4),
                "gap_before_s": round(gap, 4),
                "timing": "exact",
            }
        )
        cursor = end
    return words, phrase_rows, warnings


def plan_to_json(
    spoken_text: str,
    speech_durations: Sequence[float] | None = None,
    audio_durations: Sequence[float] | None = None,
) -> dict:
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
        words, phrase_rows, warnings = place_on_timeline(
            phrases, speech_durations, audio_durations
        )
        if not words:
            raise ValueError("Timed plan must contain at least one word")
        payload["phrases"] = phrase_rows
        payload["words"] = [asdict(w) for w in words]
        payload["speech_start_s"] = words[0].start_s
        payload["speech_end_s"] = words[-1].end_s
        payload["warnings"] = warnings
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
