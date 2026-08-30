from collections import Counter
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def test_desktop_pages_keep_one_navigation_and_settings_contract():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "styles.css").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    element_ids = re.findall(r'id="([^"]+)"', html)
    duplicate_ids = [item for item, count in Counter(element_ids).items() if count > 1]

    assert duplicate_ids == []
    assert app.count("function setSettingsTab(") == 1
    assert 'activeSettingsTab: "api"' in app
    assert 'data-settings-tab="general" hidden' in html
    assert '<div class="settings-panel active" id="settings-api">' in html
    assert "#view-settings.active" in css
    assert ".settings-panel.active" in css
    assert ".field input" in css
    assert ".provider-card" in css
    assert ".runtime-list" in css
    assert ".render-stats-grid strong" in css
    assert ".review-nav-tabs" in css
    assert ".role-progress-item" in css
    assert 'data-analysis-adjust="-10"' in html
    assert "function adjustAnalysisRange(seconds)" in app
    assert 'id="hookLayout"' in html
    assert 'id="pipelineSummary"' in html
    assert "aiTtsToggle" not in app
    assert "@keyframes view-enter" in css
    assert "button:active:not(:disabled)" in css
    assert "@media (prefers-reduced-motion: reduce)" in css
    assert 'element.classList.add("is-pointer-dragging")' in app
    assert 'element.classList.remove("is-pointer-dragging")' in app


def test_empty_ui_does_not_claim_fake_video_results():
    html = (ROOT / "index.html").read_text(encoding="utf-8")

    assert 'id="previewScore">-</strong>' in html
    assert 'id="momentSummaryBestCount">0</span>' in html
    assert 'id="momentSummaryAnalyzed">0</strong>' in html
    assert 'id="bottomSelectionText">Terpilih 0 dari 0 momen</span>' in html
    assert "BAYANGIN SEMUA ORANG TAHU" not in html
    assert "High (0.92)" not in html
    assert "$12.48" not in html
    assert 'id="walletStatus"' not in html
    assert "Estimasi Penggunaan" not in html
    assert "estimateTotalCost" not in html
    assert "estimateAiCost" not in html


def test_processing_error_banner_is_state_gated_and_hidden_by_default():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "styles.css").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert 'id="renderErrorBanner" role="alert" hidden' in html
    assert ".render-error-banner[hidden]" in css
    assert "function syncProcessingErrorBanner()" in app
    assert "function clearProcessingError()" in app
    assert "state.processingError = null" in app
    assert "const jobIsError = String($(\"#jobBadge\")?.textContent || \"\").trim().toLowerCase() === \"error\";" in app
    assert "error && error.message && jobIsError" in app
    assert "banner.hidden = !visible" in app


def test_user_cancellation_is_not_presented_as_a_processing_error():
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert "state.cancelRequested = true" in app
    assert "if (runId !== state.processingRunId || state.cancelRequested)" in app
    assert "showProcessingCancelled(phase)" in app


def test_moment_ui_exposes_auto_and_review_groups():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert '<option value="auto">Terpilih otomatis</option>' in html
    assert '<option value="recommended">Rekomendasi untuk ditinjau</option>' in html
    assert "otomatis · ${reviewCount} rekomendasi" in app
    assert '<option value="qualified" selected>Rekomendasi 70+</option>' in html
    assert 'momentQualityFilter: "qualified"' in app
    assert "function applyMomentDisplayPolicy()" in app


def test_cloud_connection_distinguishes_router_setup_from_invalid_key():
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")

    assert "cloudRouterReady" in app
    assert "AI provider belum disiapkan admin" in main
    assert "Cloud terhubung · saldo" not in main
    assert "Cloud terhubung; admin perlu menyiapkan AI provider" in app
    assert "Cliper Cloud terhubung, tetapi AI provider belum disiapkan oleh admin" in app
    assert "cloud:session-recovery" in main
    assert "wallet_usd" not in app


def test_runtime_installer_is_available_from_settings_and_packaged():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    preload = (ROOT / "electron" / "preload.js").read_text(encoding="utf-8")
    main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")
    installer = (ROOT / "scripts" / "install-runtime.ps1").read_text(encoding="utf-8")
    package = (ROOT / "package.json").read_text(encoding="utf-8")

    assert 'id="installRuntimeButton"' in html
    assert "installRuntime:" in preload
    assert 'ipcMain.handle("cliper:install-runtime"' in main
    assert '"to": "runtime/install-runtime.ps1"' in package
    assert "[switch]$InstallPython" in installer
    assert "[switch]$InstallFFmpeg" in installer
    assert "[switch]$InstallNode" in installer


def test_system_status_uses_a_single_capability_registry_and_keeps_fallbacks_explicit():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert 'data-settings-tab="runtime">System<' in html
    assert "function runtimeCapabilityRegistry" in app
    assert "function heatmapRuntimeCapability()" in app
    assert "available_outside_selection" in app
    assert "Komponen inti" in app
    assert "Analisis video" in app
    assert "Cerita dan subtitle" in app
    assert "CPU stabil - libx264" in app
    assert "Fallback crop aktif" in app


def test_moment_ui_honors_server_quality_tier_and_evidence_gate():
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert 'item.qualityTier || item.quality_tier' in app
    assert 'evidenceGate === false' in app
    assert 'if (momentQuality(item).key === "reject") return false;' in app
    assert 'evidenceGate === true && !manualReview' in app


def test_moment_scores_and_manual_alternatives_are_evidence_based():
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert "function momentScoreComponents(item)" in app
    assert '"Standalone", components.standalone' in app
    assert 'score: null,' in app
    assert 'qualityTier: "review"' in app
    assert "score: Math.max(60" not in app
    assert "Boundary alternatif perlu dianalisis ulang." in app
    assert "momentScoreOutOfTen(item);" in app
    assert "return score > 0 ? `${score}/10`" in app
    assert "costEstimateTimer" not in app
    assert "fetchCostEstimate" not in app


def test_studio_target_and_layout_contract_are_desktop_safe():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    css = (ROOT / "styles.css").read_text(encoding="utf-8")

    assert 'input id="clipCount" type="number" min="1" max="10" step="1" value="4"' in html
    assert "function normalizeRequestedClipCount" in app
    assert "function syncClipTargetControls" in app
    assert "autoClipCount: false" in app
    assert "allRecommendedClips: false" in app
    assert 'clipCount: String(normalizeRequestedClipCount(fieldValue("clipCount", "4")))' in app
    assert "#view-studio.active" in css
    assert "overflow-y: auto;" in css
    assert "@media (max-width: 1120px)" in css


def test_candidate_quality_scoring_emits_actual_progress():
    worker = (ROOT / "worker" / "cliper_worker.py").read_text(encoding="utf-8")

    assert 'stage="quality scoring"' in worker
    assert "Menilai kandidat {index + 1}/{scoring_total}" in worker
    assert "Quality scoring selesai:" in worker


def test_real_content_acceptance_uses_cached_sources_without_cloud_requests():
    acceptance = (ROOT / "scripts" / "qa-moment-acceptance.py").read_text(
        encoding="utf-8"
    )
    qa_render = (ROOT / "scripts" / "qa-real-render.ps1").read_text(
        encoding="utf-8"
    )

    assert '"providerType": "local"' in acceptance
    assert '"network": "disabled"' in acceptance
    assert "DEFAULT_CASES" in acceptance
    assert "moment-acceptance.json" in acceptance
    assert '"_heatmap_cache_path"' in acceptance
    assert "TemporaryDirectory" in acceptance
    assert "[switch]$CpuSafe" in qa_render
    assert "gpuAcceleration = -not $CpuSafe" in qa_render


def test_gpu_status_uses_ffmpeg_detected_encoders_and_preserves_cpu_fallback():
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert "function detectedHardwareStatus" in app
    assert 'h264_nvenc: "NVIDIA NVENC"' in app
    assert 'h264_amf: "AMD AMF"' in app
    assert 'h264_qsv: "Intel Quick Sync"' in app
    assert 'CPU fallback - libx264' in app
    assert 'if (id === "gpuToggle") refreshHardwareStatus();' in app


def test_desktop_version_is_read_from_the_electron_runtime():
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")
    e2e = (ROOT / "scripts" / "local-e2e-render.ps1").read_text(
        encoding="utf-8"
    )

    assert "appVersion: app.getVersion()" in main
    assert "runtimeDefaults?.appVersion" in app
    assert "`v${appVersion}`" in app
    assert 'let appVersion = "";' in app
    assert "v1.11.4" not in app
    assert '$desktopPackage = Get-Content' in e2e
    assert "appVersion = $desktopVersion" in e2e


def test_render_audit_uses_actual_encoder_and_explicit_fallback_fields():
    worker = (ROOT / "worker" / "cliper_worker.py").read_text(encoding="utf-8")
    qa_render = (ROOT / "scripts" / "qa-real-render.ps1").read_text(
        encoding="utf-8"
    )

    assert '"requestedEncoder": requested_encoder' in worker
    assert '"actualEncoder": encoder' in worker
    assert '"fallbackUsed": fallback_used' in worker
    assert '"fallbackReason": fallback_reason' in worker
    assert 'encoder = "libx264"' in worker
    assert "runtime_app_version(payload)" in worker
    assert "appVersion = $desktopVersion" in qa_render


def test_worker_credentials_are_not_written_to_payload_files_and_workers_do_not_collide():
    main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")
    worker = (ROOT / "worker" / "cliper_worker.py").read_text(
        encoding="utf-8"
    )

    assert "const activeWorkers = new Map()" in main
    assert "workerPayloadAndEnvironment" in main
    assert "delete workerPayload[field]" in main
    assert "CLIPER_WORKER_CLOUD_ACCESS_TOKEN" in main
    assert "CLIPER_WORKER_CLOUD_SIGNING_SECRET" in main
    assert "cleanupStaleWorkerPayloads();" in main
    assert "STALE_WORKER_PAYLOAD_AGE_MS" in main
    assert 'os.environ.pop(environment_name, "")' in worker
    assert "let activeWorker = null" not in main


def test_production_output_qa_requires_truthful_encoder_audit():
    qa = (ROOT / "scripts" / "qa-production-check.js").read_text(
        encoding="utf-8"
    )

    assert '"requestedEncoder"' in qa
    assert '"actualEncoder"' in qa
    assert '"fallbackUsed"' in qa
    assert '"fallbackReason"' in qa
    assert "fallbackUsed is not boolean" in qa


def test_overlay_previews_share_renderer_geometry_and_drag_coordinates():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    assert 'id="subtitlePreviewFrame"' in html
    assert 'id="subtitleX" type="hidden" value="50"' in html
    assert 'id="subtitleY" type="hidden" value="82"' in html
    assert "const OVERLAY_DESIGN_WIDTH = 1080" in app
    assert "overlayGeometryVersion: 2" in app
    assert 'bindPreviewDrag($("#subtitlePreviewText"), "subtitleX", "subtitleY"' in app
    assert "configuredSize * 0.52" not in app
