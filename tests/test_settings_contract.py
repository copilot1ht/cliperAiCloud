import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

import cliper_worker


def test_settings_contract_is_single_versioned_source_of_truth():
    contract = json.loads(
        (ROOT / "worker" / "settings-contract.json").read_text(encoding="utf-8")
    )

    assert contract["version"] == 1
    assert set(contract["booleanSettings"]) == set(contract["defaults"])
    assert contract["dependencies"]["dynamicZoom"] == "smartCrop"
    assert contract["dependencies"]["faceTrack"] == "smartCrop"
    assert contract["dependencies"]["addTtsHook"] == "addHook"
    assert contract["featureFlags"]["hookV2"] is True
    assert contract["featureFlags"]["publishingGuard"] is False
    assert contract["featureFlags"]["momentScoringV2"] is True
    assert contract["uiBindings"]["addTtsHook"] == "ttsHookToggle"
    assert contract["featureFlags"]["ttsTimelineV2"] is False


def test_legacy_settings_are_migrated_and_dependencies_are_enforced():
    payload = cliper_worker.normalize_renderer_settings(
        {
            "settingsContractVersion": 0,
            "smartCrop": False,
            "dynamicZoom": True,
            "faceTrack": True,
            "subtitleBurnToggle": False,
            "hookOpeningToggle": False,
            "ttsHookToggle": True,
            "autoVideoEnhancement": False,
        }
    )

    assert payload["settingsContractVersion"] == 1
    assert payload["_clientSettingsContractVersion"] == 0
    assert payload["rendererSettings"]["smartCrop"] is False
    assert payload["rendererSettings"]["dynamicZoom"] is False
    assert payload["rendererSettings"]["faceTrack"] is False
    assert payload["rendererSettings"]["addCaptions"] is False
    assert payload["rendererSettings"]["burnSubtitle"] is False
    assert payload["rendererSettings"]["addHook"] is False
    assert payload["rendererSettings"]["addTtsHook"] is False
    assert payload["disableAutoEnhancement"] is True


def test_settings_used_reports_actual_fallback_outcome():
    payload = cliper_worker.normalize_renderer_settings({})

    used = cliper_worker.used_renderer_settings(
        payload,
        actual_caption=False,
        actual_hook=False,
        auto_cut_applied=False,
        face_analysis=None,
        stripped_enhancements=True,
        encoder="libx264",
    )

    assert used["smartCrop"] is True
    assert used["dynamicZoom"] is False
    assert used["faceTrack"] is False
    assert used["addCaptions"] is False
    assert used["addHook"] is False
    assert used["addTtsHook"] is False
    assert used["autoVideoEnhancement"] is False
    assert used["gpuAcceleration"] is False


def test_ui_exposes_only_renderer_controls_with_real_contract_bindings():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    worker = (ROOT / "worker" / "cliper_worker.py").read_text(encoding="utf-8")

    for element_id in (
        "smartCropToggle",
        "dynamicZoomToggle",
        "faceTrackToggle",
        "autoCutToggle",
        "audioEnhanceToggle",
        "autoVideoEnhancementToggle",
    ):
        assert f'id="{element_id}"' in html

    for unused_control in (
        "overwriteExisting",
        "autoRename",
        "createProjectFolder",
        "deleteTempAfterExport",
    ):
        assert f'id="{unused_control}"' not in html

    assert "await loadSettingsContract();" in app
    assert '"settingsRequested": requested_renderer_settings(payload)' in worker
    assert '"settingsUsed": aggregate_settings_used' in worker
    assert '"videoEnhancement": True' not in worker
