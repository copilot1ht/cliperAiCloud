from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_local_e2e_keeps_manual_review_opt_in():
    script = (ROOT / "scripts" / "local-e2e-render.ps1").read_text(
        encoding="utf-8"
    )

    assert "[switch]$AllowManualReviewRender" in script
    assert "} elseif ($AllowManualReviewRender) {" in script
    assert '$report.selectionLane = "manual-review"' in script
    assert "$report.manualReviewRender = $true" in script
    assert "this does not certify automatic selection" in script
