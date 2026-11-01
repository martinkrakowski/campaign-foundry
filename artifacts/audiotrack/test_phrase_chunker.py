"""Unit tests for lane VE4: the ten AudioTrack schema/chunker defects.

Covers schema defects #1/#8, tokenizer defects #2/#5, pause and soft-break
defect #6, quote-repair defect #7, sentence-end absorption defect #9,
zero-duration defect #3, timeline output defect #4, and allocation
defect #10, plus the spec §5 worked-example regression.
"""

import json
import os
import unittest

from phrase_chunker import (
    ChunkerConfig,
    PhrasePlan,
    Token,
    _punct_pause,
    allocate_phrase,
    plan_to_json,
    split_phrases,
    syllable_count,
    tokenize,
)

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "audiotrack.schema.json")


def _load_schema() -> dict:
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        return json.load(fh)


class SchemaDefectTests(unittest.TestCase):
    """Defects #1 and #8."""

    def test_audio_oneof_is_exactly_two_mutually_exclusive_branches(self):
        oneof = _load_schema()["properties"]["audio"]["oneOf"]
        self.assertEqual(len(oneof), 2)
        branch_uri, branch_b64 = oneof
        self.assertEqual(branch_uri["required"], ["uri"])
        self.assertEqual(branch_uri["properties"]["uri"]["type"], "string")
        self.assertEqual(branch_uri["properties"]["uri"]["minLength"], 1)
        self.assertEqual(branch_uri["properties"]["audio_base64"]["type"], "null")
        self.assertEqual(branch_b64["required"], ["uri", "audio_base64"])
        self.assertEqual(branch_b64["properties"]["uri"]["type"], "null")
        self.assertEqual(branch_b64["properties"]["audio_base64"]["type"], "string")
        self.assertEqual(branch_b64["properties"]["audio_base64"]["minLength"], 1)

    def test_top_level_required_includes_speech_bounds(self):
        required = _load_schema()["required"]
        self.assertIn("speech_start_s", required)
        self.assertIn("speech_end_s", required)

    def test_words_min_items_is_one(self):
        words = _load_schema()["properties"]["words"]
        self.assertEqual(words["minItems"], 1)


class UnicodeTokenizationTests(unittest.TestCase):
    """Defect #2."""

    def test_accented_words_stay_whole_with_exact_offsets(self):
        toks = tokenize("Café naïve — résumé")
        words = [t for t in toks if t.kind == "word"]
        self.assertEqual([t.text for t in words], ["Café", "naïve", "résumé"])
        self.assertEqual(
            [(t.start, t.end) for t in words], [(0, 4), (5, 10), (13, 19)]
        )

    def test_syllable_count_cafe_is_two(self):
        self.assertEqual(syllable_count("café"), 2)

    def test_ascii_words_produce_identical_weights(self):
        from phrase_chunker import word_weight

        self.assertEqual(word_weight("late"), 0.35 * 4 + 0.65 * 1)

    def test_syllable_count_silent_e_on_accented_spellings(self):
        self.assertEqual(syllable_count("café"), 2)
        self.assertEqual(syllable_count("naïve"), 1)
        self.assertEqual(syllable_count("façade"), 2)


class DoubleHyphenDashTests(unittest.TestCase):
    """Defect #5."""

    def test_double_hyphen_is_one_punct_token(self):
        toks = tokenize("Wait -- really?")
        dashes = [t for t in toks if t.text == "--"]
        self.assertEqual(len(dashes), 1)
        self.assertEqual(dashes[0].kind, "punct")

    def test_double_hyphen_pause_matches_em_dash(self):
        cfg = ChunkerConfig()
        self.assertEqual(_punct_pause("--", cfg), _punct_pause("—", cfg))
        self.assertEqual(_punct_pause("--", cfg), cfg.pause_dash_s)

    def test_double_hyphen_split_and_internal_gap(self):
        # "--" is a comma-like split trigger once min_words is met...
        split_cfg = ChunkerConfig(min_words=2)
        phrases = split_phrases("one two -- three four", split_cfg)
        self.assertEqual([p.text for p in phrases], ["one two --", "three four"])
        # ...and a pause-class punct inside a phrase: the gap before the next
        # word equals pause_dash_s.
        cfg = ChunkerConfig()
        single = split_phrases("one two -- three four five six seven")
        self.assertEqual(len(single), 1)
        out = allocate_phrase(single[0], 2.0)
        gap = out[2].start_s - out[1].end_s
        self.assertAlmostEqual(gap, cfg.pause_dash_s, places=4)


class ParenPauseTests(unittest.TestCase):
    """Defect #6."""

    def test_config_has_paren_pause_default(self):
        self.assertEqual(ChunkerConfig().pause_paren_s, 0.04)

    def test_punct_pause_returns_paren_pause(self):
        cfg = ChunkerConfig()
        self.assertEqual(_punct_pause("(", cfg), 0.04)
        self.assertEqual(_punct_pause(")", cfg), 0.04)

    def test_close_paren_soft_break_when_min_words_reached(self):
        phrases = split_phrases("One two three (four) after.")
        self.assertEqual(
            [p.text for p in phrases], ["One two three (four)", "after."]
        )


class QuoteRepairTests(unittest.TestCase):
    """Defect #7."""

    def test_opening_quote_never_pulled_onto_previous_phrase(self):
        phrases = split_phrases('Stop. "Hello" she said.')
        self.assertEqual(
            [p.text for p in phrases], ["Stop.", '"Hello" she said.']
        )

    def test_overflow_breaks_before_word_even_inside_quotes(self):
        cfg = ChunkerConfig(max_words=3)
        phrases = split_phrases('He said "go now before dusk" quickly', cfg)
        self.assertTrue(all(len(p.word_tokens) <= 3 for p in phrases))
        self.assertEqual(
            [p.text for p in phrases],
            ['He said "go', 'now before dusk"', "quickly"],
        )

    def test_cap_still_applies_after_apostrophe_opening_quote(self):
        cfg = ChunkerConfig(max_words=2)
        phrases = split_phrases("the '90s and more", cfg)
        self.assertTrue(all(len(p.word_tokens) <= 2 for p in phrases))
        self.assertEqual([p.text for p in phrases], ["the '90s", "and more"])

    def test_close_quote_stays_with_sentence(self):
        phrases = split_phrases('He said "wait." Next.')
        self.assertEqual([p.text for p in phrases], ['He said "wait."', "Next."])


class SentenceEndAbsorptionTests(unittest.TestCase):
    """Defect #9."""

    def test_question_bang_stays_together(self):
        phrases = split_phrases("Wait?! Next.")
        self.assertEqual([p.text for p in phrases], ["Wait?!", "Next."])
        self.assertEqual(phrases[0].ends_with, "!")

    def test_ellipsis_run_stays_together(self):
        phrases = split_phrases("Wait... Next.")
        self.assertEqual([p.text for p in phrases], ["Wait...", "Next."])
        self.assertEqual(phrases[1].text.startswith("Next"), True)


class ZeroDurationAllocationTests(unittest.TestCase):
    """Defect #3."""

    @staticmethod
    def _phrase_of(words):
        toks = [
            Token(text=w, kind="word", start=idx * 3, end=idx * 3 + len(w))
            for idx, w in enumerate(words)
        ]
        return PhrasePlan(
            i=0,
            text=" ".join(w.text for w in toks),
            tokens=toks,
            word_tokens=toks,
            ends_with="",
            char_start=toks[0].start,
            char_end=toks[-1].end,
        )

    def test_negative_duration_raises(self):
        with self.assertRaises(ValueError):
            allocate_phrase(self._phrase_of(["Stop"]), -0.1)

    def test_zero_duration_one_word_returns_empty_with_warning(self):
        warnings: list[dict] = []
        out = allocate_phrase(self._phrase_of(["Stop"]), 0.0, warnings_out=warnings)
        self.assertEqual(out, [])
        self.assertEqual(warnings[0]["code"], "EMPTY_PHRASE_AUDIO")
        self.assertEqual(warnings[0]["phrase_index"], 0)

    def test_zero_duration_three_words_returns_empty_with_warning(self):
        warnings: list[dict] = []
        out = allocate_phrase(
            self._phrase_of(["one", "two", "three"]), 0.0, warnings_out=warnings
        )
        self.assertEqual(out, [])
        self.assertEqual(warnings[0]["code"], "EMPTY_PHRASE_AUDIO")

    def test_timings_always_strictly_increasing(self):
        for dur in (0.15, 0.5, 2.0, 6.0):
            out = allocate_phrase(self._phrase_of(["one", "two", "three"]), dur)
            self.assertTrue(all(w.end_s > w.start_s for w in out), dur)


class TimelineOutputTests(unittest.TestCase):
    """Defect #4."""

    def test_plan_to_json_numeric_audio_duration_and_warnings(self):
        plan = plan_to_json(
            "Hello world there today. Next one here.", [1.0, 1.0], [3.0, 1.0]
        )
        for phrase, audio, speech in zip(
            plan["phrases"], [3.0, 1.0], [1.0, 1.0]
        ):
            self.assertEqual(phrase["audio_duration_s"], audio)
            self.assertGreaterEqual(phrase["audio_duration_s"], speech)
        self.assertEqual(plan["speech_start_s"], plan["words"][0]["start_s"])
        self.assertIn("warnings", plan)
        codes = [w["code"] for w in plan["warnings"]]
        self.assertIn("SILENCE_HEAVY", codes)

    def test_audio_duration_defaults_to_speech_duration(self):
        plan = plan_to_json("Hello world there today.", [1.0])
        self.assertEqual(plan["phrases"][0]["audio_duration_s"], 1.0)
        self.assertNotIn("SILENCE_HEAVY", [w["code"] for w in plan["warnings"]])

    def test_silence_heavy_threshold(self):
        plan = plan_to_json("Hello world there today.", [1.0], [3.0])
        # 1.0 < 0.35 * 3.0 -> SILENCE_HEAVY
        self.assertTrue(
            any(w["code"] == "SILENCE_HEAVY" for w in plan["warnings"])
        )
        plan_ok = plan_to_json("Hello world there today.", [1.0], [2.8])
        # 1.0 >= 0.35 * 2.8 -> no warning
        self.assertFalse(
            any(w["code"] == "SILENCE_HEAVY" for w in plan_ok["warnings"])
        )


class WaterfillAllocationTests(unittest.TestCase):
    """Defect #10."""

    @staticmethod
    def _phrase_of(words):
        toks = [
            Token(text=w, kind="word", start=idx * 3, end=idx * 3 + len(w))
            for idx, w in enumerate(words)
        ]
        return PhrasePlan(
            i=0,
            text=" ".join(w.text for w in toks),
            tokens=toks,
            word_tokens=toks,
            ends_with="",
            char_start=toks[0].start,
            char_end=toks[-1].end,
        )

    def test_skewed_weights_waterfill_within_bounds(self):
        # Measured defect-10 case (docs/planning/2026-09-13...): a long word
        # beside three short ones over 2.0 s. The old allocator returned
        # 1.6216 s for the long word; the clamp must bind at 0.90 and the
        # remainder must be redistributed inside [min_word_s, max_word_s].
        out = allocate_phrase(
            self._phrase_of(
                ["pneumonoultramicroscopicsilicovolcanoconiosis", "a", "I", "b"]
            ),
            2.0,
        )
        durs = [w.end_s - w.start_s for w in out]
        self.assertAlmostEqual(durs[0], 0.90, places=4)
        for d in durs:
            self.assertGreaterEqual(d, 0.07)
            self.assertLessEqual(d, 0.90)
        self.assertAlmostEqual(sum(durs), 2.0, places=6)
        self.assertAlmostEqual(out[-1].end_s, 2.0, places=6)

    def test_single_word_long_clip_is_rate_clamped(self):
        warnings: list[dict] = []
        out = allocate_phrase(
            self._phrase_of(["Stop"]), 5.0, warnings_out=warnings
        )
        self.assertEqual(out[0].end_s, 0.90)
        self.assertEqual(warnings[0]["code"], "RATE_CLAMPED")

    def test_three_words_short_clip_is_rate_clamped(self):
        warnings: list[dict] = []
        out = allocate_phrase(
            self._phrase_of(["one", "two", "three"]), 0.15, warnings_out=warnings
        )
        self.assertAlmostEqual(out[-1].end_s, 0.15, places=6)
        self.assertTrue(all(w.end_s > w.start_s for w in out))
        self.assertEqual(warnings[0]["code"], "RATE_CLAMPED")


class SpecWorkedExampleTests(unittest.TestCase):
    """Spec §5 regression."""

    TEXT = (
        "Stop scrolling. Your Q3 numbers — they're already late. "
        "Fix the pipeline in ten minutes."
    )

    def test_phrase_boundaries(self):
        plan = plan_to_json(self.TEXT, [0.78, 1.92, 1.48])
        self.assertEqual(
            [p["text"] for p in plan["phrases"]],
            [
                "Stop scrolling.",
                "Your Q3 numbers — they're already late.",
                "Fix the pipeline in ten minutes.",
            ],
        )

    def test_word_timings_match_spec(self):
        plan = plan_to_json(self.TEXT, [0.78, 1.92, 1.48])
        words = plan["words"]
        # Phrase 0: Stop / scrolling split the 0.78s clip by weight.
        self.assertAlmostEqual(words[0]["start_s"], 0.0, places=4)
        self.assertAlmostEqual(words[1]["end_s"], 0.78, places=4)
        # Phrase 1 starts after the 0.28s sentence gap.
        self.assertAlmostEqual(words[2]["start_s"], 1.06, places=4)
        # Total speech span.
        self.assertAlmostEqual(plan["speech_end_s"], 4.74, places=4)

    def test_spec5_example_comma_gap_and_durations(self):
        plan = plan_to_json(
            "The market opened lower after overnight futures sold off, and yields jumped.",
            [2.86, 1.05],
        )
        phrases = plan["phrases"]
        self.assertEqual(
            [p["text"] for p in phrases],
            [
                "The market opened lower after overnight futures sold off,",
                "and yields jumped.",
            ],
        )
        self.assertAlmostEqual(phrases[0]["speech_duration_s"], 2.86, places=4)
        self.assertAlmostEqual(phrases[1]["speech_duration_s"], 1.05, places=4)
        self.assertAlmostEqual(phrases[1]["gap_before_s"], 0.14, places=4)
        self.assertAlmostEqual(phrases[1]["start_s"], 3.00, places=4)
        self.assertAlmostEqual(plan["speech_end_s"], 4.05, places=4)


class OverflowPunctuationTests(unittest.TestCase):
    def test_leading_quote_survives_a_max_chars_overflow(self):
        phrases = split_phrases('"hello', ChunkerConfig(max_chars=5))
        self.assertIn('"', "".join(p.text for p in phrases))


if __name__ == "__main__":
    unittest.main()
