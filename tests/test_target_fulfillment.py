"""
Regression tests for target fulfillment and public score calibration.
Tests are self-contained — they extract the calibration function directly
to avoid importing the full worker with all its heavy dependencies.
"""

# ---- Extract calibrate_public_score from worker source ----
import re, ast

def _extract_function(filepath, func_name):
    """Extract a standalone function from a Python source file."""
    with open(filepath, "r", encoding="utf-8") as f:
        source = f.read()
    # Find function definition
    pattern = rf'^(def {func_name}\(.*?\n(?:(?:    .*|)\n)*)'
    match = re.search(pattern, source, re.MULTILINE)
    if not match:
        raise ValueError(f"Function {func_name} not found in {filepath}")
    func_source = match.group(1)
    # Compile and exec in isolated namespace
    ns = {}
    exec(compile(func_source, filepath, "exec"), ns)
    return ns[func_name]

import os, sys
WORKER_PATH = os.path.join(os.path.dirname(__file__), "..", "worker", "cliper_worker.py")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "worker"))
import cliper_worker

calibrate_public_score = _extract_function(WORKER_PATH, "calibrate_public_score")


# ---- Test calibrate_public_score monotonicity ----
def test_monotonic():
    """Higher raw score must NEVER produce lower display score."""
    previous = -1.0
    for raw in range(0, 101):
        display = calibrate_public_score(raw)
        assert display >= previous, (
            f"FAIL monotonicity: raw={raw}→{display}, prev raw={raw-1}→{previous}"
        )
        previous = display
    print("  PASS: monotonic across 0-100")


def test_key_mapping():
    """Verify key mapping points match the latest spec (viable min 7.9, max 10.0):
    raw 0.0 -> 0.0
    raw 4.0 -> 6.8
    raw 4.5 -> 7.9
    raw 5.0 -> 8.0
    raw 5.5 -> 8.1
    raw 6.0 -> 8.2 (was 7.2 -> 8.2)
    raw 6.25 -> 8.4 (was 7.4 -> 8.4)
    raw 6.5 -> 8.6 (was 7.6 -> 8.6)
    raw 7.0 -> 9.0 (was 8.0 -> 9.0)
    raw 7.5 -> 9.3 (was 8.3 -> 9.3)
    raw 8.0 -> 9.5
    raw 8.5 -> 9.7
    raw 9.0 -> 9.8
    raw 9.5 -> 9.9
    raw 10  -> 10.0
    Also verifies 0-100 scale: raw 45 -> 7.9, 50 -> 8.0, ..., 100 -> 10.0
    """
    table = [
        (0.0, 0.0),
        (4.0, 6.8),
        (4.5, 7.9),
        (5.0, 8.0),
        (5.5, 8.1),
        (6.0, 8.2),
        (6.25, 8.4),
        (6.5, 8.6),
        (7.0, 9.0),
        (7.5, 9.3),
        (8.0, 9.5),
        (8.5, 9.7),
        (9.0, 9.8),
        (9.5, 9.9),
        (10.0, 10.0),
    ]
    for raw, expected in table:
        # Test 0-10 scale
        display_10 = calibrate_public_score(raw)
        assert display_10 == expected, f"FAIL: raw={raw} -> {display_10}, expected {expected}"
        # Test 0-100 scale
        display_100 = calibrate_public_score(raw * 10.0)
        assert display_100 == expected, f"FAIL: raw={raw * 10.0} -> {display_100}, expected {expected}"
    print("  PASS: key mapping points verified across both scales")


def test_no_evidence_does_not_display_as_recommended():
    assert calibrate_public_score(0) == 0.0
    assert calibrate_public_score(25) < 7.9
    assert calibrate_public_score(40) < 7.9
    assert calibrate_public_score(45) == 7.9


def test_viable_range():
    """Viable clips (raw 4.5 to 9.5 / 45 to 95) should show 7.9 to 9.9."""
    for raw_int in range(45, 96):
        display = calibrate_public_score(raw_int)
        assert 7.9 <= display <= 9.9, f"FAIL: raw={raw_int} -> {display}, expected [7.9, 9.9]"
    print("  PASS: viable range 45-95 maps to 7.9-9.9")


def test_10_only_exceptional():
    """Only raw 10 / 100 gets 10.0."""
    for raw in range(0, 100):
        display = calibrate_public_score(raw)
        assert display < 10.0, f"FAIL: raw={raw} should not get 10.0"
    assert calibrate_public_score(100) == 10.0
    assert calibrate_public_score(10.0) == 10.0
    print("  PASS: 10.0 only for raw >= 100")


def test_no_randomness():
    """Same input always produces same output."""
    for raw in [0, 25, 40, 55, 65, 75, 85, 95, 100]:
        a = calibrate_public_score(raw)
        b = calibrate_public_score(raw)
        assert a == b, f"FAIL: raw={raw} not deterministic: {a} vs {b}"
    print("  PASS: deterministic (no randomness)")


# ---- Target fulfillment simulation ----
def test_target_fulfillment():
    """Simulate the shortlist logic with relaxed gate."""
    # Relaxed gate: reject only score < 40 or rejected=True
    def gate(candidate):
        if candidate.get("rejected"):
            return False
        if (candidate.get("score") or 0) < 40:
            return False
        return True

    def make_candidates(count, base_score=55):
        return [
            {"id": i + 1, "score": base_score + i * 3, "evidence_gate": (i % 2 == 0)}
            for i in range(count)
        ]

    def select(candidates, target):
        viable = [c for c in candidates if gate(c)]
        viable.sort(key=lambda c: c["score"], reverse=True)
        return viable[:target]

    # Test cases from spec
    cases = [
        # (target, analyzed, expected_returned)
        (4, 8, 4),
        (6, 6, 6),
        (6, 4, 4),
        (10, 8, 8),
        (6, 8, 6),
    ]

    for target, analyzed, expected in cases:
        candidates = make_candidates(analyzed, 55)
        result = select(candidates, target)
        actual = len(result)
        status = "PASS" if actual == expected else "FAIL"
        display_scores = [calibrate_public_score(c["score"]) for c in result]
        print(f"  {status}: target={target} | analyzed={analyzed} | viable={analyzed} | returned={actual} | scores={display_scores}")
        assert actual == expected, f"Expected {expected}, got {actual}"


def test_display_distribution():
    """Print full distribution for manual review."""
    print("\n  RAW -> DISPLAY mapping:")
    for raw in [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 97, 100]:
        display = calibrate_public_score(raw)
        print(f"    raw={raw:3d} -> display={display}")


def test_public_labels():
    """Verify label calibration matches updated spec:
    7.9–8.3 = Layak
    8.4–9.3 = Direkomendasikan
    9.4–10 = Pilihan Terbaik
    """
    assert cliper_worker.calibrate_public_label(7.9) == "Layak"
    assert cliper_worker.calibrate_public_label(8.0) == "Layak"
    assert cliper_worker.calibrate_public_label(8.2) == "Layak"
    assert cliper_worker.calibrate_public_label(8.3) == "Layak"
    assert cliper_worker.calibrate_public_label(8.4) == "Direkomendasikan"
    assert cliper_worker.calibrate_public_label(8.5) == "Direkomendasikan"
    assert cliper_worker.calibrate_public_label(9.0) == "Direkomendasikan"
    assert cliper_worker.calibrate_public_label(9.3) == "Direkomendasikan"
    assert cliper_worker.calibrate_public_label(9.4) == "Pilihan Terbaik"
    assert cliper_worker.calibrate_public_label(9.8) == "Pilihan Terbaik"
    assert cliper_worker.calibrate_public_label(10.0) == "Pilihan Terbaik"
    assert cliper_worker.calibrate_public_label(5.8) == "Perlu Review"
    assert cliper_worker.calibrate_public_label(7.0) == "Perlu Review"
    print("  PASS: public labels calibrated correctly")


def test_qa_wajib_target_tolerance():
    """QA WAJIB:
    target1 -> ~1 (1-2)
    target2 -> 1-3
    target4 -> 3-5 (or 6 if exceptional)
    target6 -> 5-7 (or 8 if exceptional)
    target8 -> 7-9 (or 10 if exceptional)
    target10 -> 9-10
    """
    def make_viable_candidates(count, base_score=75):
        return [
            {
                "id": i + 1,
                "score": base_score - i,
                "evidence_gate": True,
                "metrics": {
                    "story_complete": 65,
                    "retention_predictor": 70,
                    "payoff": 50,
                    "hook": 50,
                },
            }
            for i in range(count)
        ]

    # Target 1 -> ~1 (1-2)
    c1 = make_viable_candidates(5)
    rec1, _ = cliper_worker.adaptive_recommendation_count(c1, 1)
    assert 1 <= rec1 <= 2, f"Target 1 expected 1-2, got {rec1}"

    # Target 2 -> 1-3
    c2 = make_viable_candidates(5)
    rec2, _ = cliper_worker.adaptive_recommendation_count(c2, 2)
    assert 1 <= rec2 <= 3, f"Target 2 expected 1-3, got {rec2}"

    # Target 4 -> 3-5
    c4 = make_viable_candidates(5)
    rec4, _ = cliper_worker.adaptive_recommendation_count(c4, 4)
    assert 3 <= rec4 <= 5, f"Target 4 expected 3-5, got {rec4}"

    # Target 6 -> 5-7
    c6 = make_viable_candidates(7)
    rec6, _ = cliper_worker.adaptive_recommendation_count(c6, 6)
    assert 5 <= rec6 <= 7, f"Target 6 expected 5-7, got {rec6}"

    # Target 8 -> 7-9
    c8 = make_viable_candidates(9)
    rec8, _ = cliper_worker.adaptive_recommendation_count(c8, 8)
    assert 7 <= rec8 <= 9, f"Target 8 expected 7-9, got {rec8}"

    # Target 10 -> 9-10
    c10 = make_viable_candidates(10)
    rec10, _ = cliper_worker.adaptive_recommendation_count(c10, 10)
    assert 9 <= rec10 <= 10, f"Target 10 expected 9-10, got {rec10}"
    print("  PASS: QA WAJIB target tolerances verified")


def test_qa_khusus_target_six_scenarios():
    """Test khusus:
    target6 + viable8 kuat => 6-8
    target6 + viable5 => 5
    target6 + viable3 => 3
    target6 + viable0 => 0 ONLY jika benar-benar semuanya invalid.
    """
    def make_cand(i, score, exceptional=False, invalid=False):
        if invalid:
            return {
                "id": i + 1,
                "score": 25,
                "rejected": True,
                "reject_reason": "Broken story mid-sentence",
                "metrics": {"dangling_start": True, "dangling_end": True},
            }
        return {
            "id": i + 1,
            "score": score,
            "evidence_gate": True,
            "exceptional": exceptional,
            "metrics": {
                "story_complete": 65 if exceptional else 55,
                "retention_predictor": 70,
                "payoff": 50 if exceptional else 35,
                "hook": 50 if exceptional else 35,
            },
        }

    # Scenario 1: target6 + viable8 kuat (with #8 exceptional) => 8 (in 6-8)
    c_8_kuat = [make_cand(i, 85 - i, exceptional=True) for i in range(8)]
    rec, _ = cliper_worker.adaptive_recommendation_count(c_8_kuat, 6)
    assert 6 <= rec <= 8, f"Expected 6-8, got {rec}"
    assert rec == 8, f"Expected 8 for strong candidates, got {rec}"

    # Scenario 2: target6 + viable5 => 5
    c_5 = [make_cand(i, 75 - i) for i in range(5)]
    rec, _ = cliper_worker.adaptive_recommendation_count(c_5, 6)
    assert rec == 5, f"Expected 5, got {rec}"

    # Scenario 3: target6 + viable3 => 3
    c_3 = [make_cand(i, 75 - i) for i in range(3)]
    rec, _ = cliper_worker.adaptive_recommendation_count(c_3, 6)
    assert rec == 3, f"Expected 3, got {rec}"

    # Scenario 4: target6 + viable0 (all invalid) => 0
    c_invalid = [make_cand(i, 20, invalid=True) for i in range(6)]
    rec, _ = cliper_worker.adaptive_recommendation_count(c_invalid, 6)
    assert rec == 0, f"Expected 0 for completely invalid pool, got {rec}"

    # Scenario 5: Legacy bug reproduction: target6 + analyzed8 (5 viable, 3 invalid) MUST NOT return 0 or 1!
    c_legacy = [make_cand(i, 65 - i) for i in range(5)] + [make_cand(i + 5, 20, invalid=True) for i in range(3)]
    topics = [
        "jadwal kereta api terlambat",
        "pasar tradisional bahan segar",
        "pengembangan model kecerdasan buatan",
        "teknik budidaya tanaman hidroponik",
        "eksplorasi peninggalan candi kuno",
        "tips berenang jarak jauh",
        "analisis grafik pasar modal",
        "konsep rumah hemat energi",
    ]
    for c in c_legacy:
        c["start"] = float(c["id"] * 100)
        c["end"] = float(c["id"] * 100 + 60)
        c["text"] = f"Cerita mengenai {topics[c['id'] - 1]} memberikan konteks dan membuktikan hasil akhir."
    supplemented = cliper_worker.supplement_with_optional_review_candidates(
        [c_legacy[0]], c_legacy, result_limit=6, video_duration=1200
    )
    assert len(supplemented) >= 5, f"Legacy bug! target6 with 5 viable returned {len(supplemented)} (must be >= 5, never 0/1)"
    print("  PASS: QA Khusus target 6 scenarios verified (including legacy bug non-regression)")


if __name__ == "__main__":
    print("\n=== Target Fulfillment & Public Score Regression Tests ===\n")

    print("1. Monotonicity:")
    test_monotonic()

    print("\n2. Key mapping:")
    test_key_mapping()

    print("\n3. Viable range:")
    test_viable_range()

    print("\n4. 10.0 only exceptional:")
    test_10_only_exceptional()

    print("\n5. Deterministic:")
    test_no_randomness()

    print("\n6. Target fulfillment:")
    test_target_fulfillment()

    print("\n7. Display distribution:")
    test_display_distribution()

    print("\n8. Public labels:")
    test_public_labels()

    print("\n9. QA WAJIB target tolerances:")
    test_qa_wajib_target_tolerance()

    print("\n10. QA Khusus target 6 scenarios:")
    test_qa_khusus_target_six_scenarios()

    print("\n=== ALL TESTS PASSED ===\n")
