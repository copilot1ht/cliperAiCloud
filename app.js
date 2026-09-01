const state = {
  view: "studio",
  selectedMoments: new Set(),
  progress: 0,
  processingTimer: null,
  scanCount: 0,
  cookiesPath: "",
  cookiesInfo: null,
  pendingSessionResume: null,
  config: {},
  settingsContract: null,
  dependencies: null,
  activeSettingsTab: "api",
  renderStartedAt: null,
  jobMode: "idle",
  renderStepStatus: {},
  renderErrors: [],
  lastAnalysis: null,
  lastTranscript: [],
  activeMomentId: null,
  videoDuration: 0,
  previewImageUrl: "",
  momentSearch: "",
  momentQualityFilter: "qualified",
  momentSort: "score",
  apiLastTestedAt: "",
  apiLastLatencyMs: 0,
  apiLastResponse: "",
  cloudConnectionOk: false,
  cloudRouterReady: false,
  cloudConnectionKeyFingerprint: "",
  processingError: null,
  processingRunId: 0,
  cancelRequested: false,
  aiUsageToday: { date: "", inputTokens: 0, outputTokens: 0, estimatedCostRp: 0 },
  subtitlePreviewTimer: null,
  logLines: [
    "[ready] Menunggu link YouTube"
  ]
};

let appVersion = "";
const AUTO_SELECT_MIN_SCORE = 70;
const MANUAL_RENDER_MIN_SCORE = 65;

let momentBank = [];

const analysisSteps = [
  { id: "subtitle", label: "Download subtitle" },
  { id: "ai", label: "Find highlights with AI" }
];

const renderStepsConfig = [
  { id: "download", label: "Download video sections" },
  { id: "portrait", label: "Portrait conversion (9:16)" },
  { id: "hook", label: "Hook generation" },
  { id: "caption", label: "Caption generation" },
  { id: "watermark", label: "Watermark overlay" }
];

let sessions = [];

const providerTasks = [
  ["aiHighlightToggle", "Highlight finder", "Hook, retention, virality"],
  ["aiCaptionToggle", "Caption cleaner", "Subtitle cleanup"],
  ["aiHookToggle", "Hook maker", "Opening text"],
  ["aiTitleToggle", "Title maker", "Title, hashtag, description"]
];

const aiProviders = {
  cloud: { label: "Cliper AI Cloud", baseUrl: "https://api.cliperaicloud.online/v1", model: "auto", readonly: true }
};
const aiProviderDefaults = aiProviders;

function normalizeCloudEndpoint(value) {
  const fallback = aiProviders.cloud.baseUrl;
  const candidate = String(value || "").trim().replace(/\/+$/, "");
  if (!candidate) return fallback;
  // A clip_sk key belongs to Cliper Cloud, never to a provider API directly.
  if (/api\.deepseek\.com|api\.openai\.com|generativelanguage\.googleapis\.com/i.test(candidate)) {
    return fallback;
  }
  return candidate;
}

const PRODUCTION_RENDER_PRESET = {
  smartCrop: true,
  dynamicZoom: true,
  faceTrack: true,
  addCaptions: true,
  burnSubtitle: true,
  autoCut: true,
  addHook: true,
  addTtsHook: false,
  audioEnhance: true,
  autoVideoEnhancement: true,
  gpuAcceleration: true,
  logoOverlay: false,
  creditText: false,
  exportThumbnailPreview: false,
  writeMetadata: false,
  metadataToggle: false
};

const OUTPUT_QUALITY_PRESETS = {
  balanced: {
    label: "Balanced 1080p",
    formatProfile: "9:16 YouTube Shorts",
    resolutionProfile: "1080p",
    fpsProfile: "Same as source",
    crfProfile: "23",
    videoBitrate: "",
    videoMaxrate: "",
    videoBufsize: "",
    audioBitrate: "160k"
  },
  capcut_opus_2k: {
    label: "CapCut / Opus 2K 60fps",
    formatProfile: "9:16 YouTube Shorts",
    resolutionProfile: "2K",
    fpsProfile: "60 FPS",
    crfProfile: "18",
    videoBitrate: "32M",
    videoMaxrate: "35M",
    videoBufsize: "64M",
    audioBitrate: "192k"
  },
  light_fast: {
    label: "Fast small file",
    formatProfile: "9:16 YouTube Shorts",
    resolutionProfile: "1080p",
    fpsProfile: "30 FPS",
    crfProfile: "24",
    videoBitrate: "10M",
    videoMaxrate: "14M",
    videoBufsize: "20M",
    audioBitrate: "160k"
  }
};

function getProductionRenderPreset() {
  const settings = normalizeRendererSettings(state.config);
  const bindings = state.settingsContract?.uiBindings || {};
  for (const [setting, elementId] of Object.entries(bindings)) {
    const node = document.getElementById(elementId);
    if (node) settings[setting] = Boolean(fieldValue(elementId, settings[setting]));
  }
  return {
    ...PRODUCTION_RENDER_PRESET,
    ...enforceRendererSettingDependencies(settings)
  };
}

function syncRendererSettingDependencies() {
  const dependencies = state.settingsContract?.dependencies || {};
  for (const [setting, parent] of Object.entries(dependencies)) {
    const childId = state.settingsContract?.uiBindings?.[setting];
    const parentId = state.settingsContract?.uiBindings?.[parent];
    const child = childId ? document.getElementById(childId) : null;
    const parentNode = parentId ? document.getElementById(parentId) : null;
    if (child && parentNode && child !== parentNode) {
      child.disabled = !Boolean(parentNode.checked);
    }
  }
  const ttsHook = document.getElementById("ttsHookToggle");
  const ttsAvailable = state.settingsContract?.featureFlags?.ttsTimelineV2 === true;
  if (ttsHook && !ttsAvailable) {
    ttsHook.checked = false;
    ttsHook.disabled = true;
  }
  const ttsStatus = document.getElementById("ttsHookStatus");
  if (ttsStatus) {
    ttsStatus.textContent = ttsAvailable ? "Tersedia" : "Menunggu validasi suara";
  }
}

function getOutputQualityPreset(profile) {
  return OUTPUT_QUALITY_PRESETS[profile] || OUTPUT_QUALITY_PRESETS.balanced;
}

function settingsContractDefaults() {
  return {
    ...PRODUCTION_RENDER_PRESET,
    ...(state.settingsContract?.defaults || {})
  };
}

function booleanSetting(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return Boolean(fallback);
}

function enforceRendererSettingDependencies(settings) {
  const normalized = { ...settings };
  const dependencies = state.settingsContract?.dependencies || {
    dynamicZoom: "smartCrop",
    faceTrack: "smartCrop",
    burnSubtitle: "addCaptions",
    addTtsHook: "addHook"
  };
  for (const [setting, parent] of Object.entries(dependencies)) {
    if (!normalized[parent]) normalized[setting] = false;
  }
  return normalized;
}

function normalizeRendererSettings(source = {}) {
  const contract = state.settingsContract || {};
  const defaults = settingsContractDefaults();
  const nested = source?.rendererSettings && typeof source.rendererSettings === "object"
    ? source.rendererSettings
    : {};
  const names = contract.booleanSettings || Object.keys(defaults).filter(
    (name) => typeof defaults[name] === "boolean"
  );
  const aliases = contract.legacyAliases || {};
  const normalized = {};
  for (const name of names) {
    const candidates = [nested[name], source?.[name]];
    for (const alias of aliases[name] || []) {
      candidates.push(nested[alias], source?.[alias]);
    }
    const selected = candidates.find((value) => value !== undefined && value !== null);
    normalized[name] = booleanSetting(selected, defaults[name]);
  }
  return enforceRendererSettingDependencies(normalized);
}

async function loadSettingsContract() {
  try {
    const contract = await window.cliper?.getSettingsContract?.();
    if (
      contract
      && Number.isSafeInteger(contract.version)
      && contract.defaults
      && Array.isArray(contract.booleanSettings)
    ) {
      state.settingsContract = contract;
      return;
    }
  } catch (error) {
    pushLog(`[settings] contract fallback: ${error.message}`);
  }
  state.settingsContract = {
    version: 1,
    booleanSettings: Object.keys(PRODUCTION_RENDER_PRESET).filter(
      (name) => typeof PRODUCTION_RENDER_PRESET[name] === "boolean"
    ),
    defaults: { ...PRODUCTION_RENDER_PRESET },
    uiBindings: {
      smartCrop: "smartCropToggle",
      dynamicZoom: "dynamicZoomToggle",
      faceTrack: "faceTrackToggle",
      addCaptions: "subtitleBurnToggle",
      burnSubtitle: "subtitleBurnToggle",
      autoCut: "autoCutToggle",
      addHook: "hookOpeningToggle",
      addTtsHook: "ttsHookToggle",
      audioEnhance: "audioEnhanceToggle",
      autoVideoEnhancement: "autoVideoEnhancementToggle",
      gpuAcceleration: "gpuToggle"
    },
    legacyAliases: {
      addCaptions: ["subtitleBurnToggle"],
      burnSubtitle: ["subtitleBurnToggle"],
      addHook: ["hookOpeningToggle"],
      addTtsHook: ["ttsHookToggle"],
      audioEnhance: ["audioEnhanceToggle"],
      gpuAcceleration: ["gpuToggle"]
    },
    dependencies: {
      dynamicZoom: "smartCrop",
      faceTrack: "smartCrop",
      burnSubtitle: "addCaptions",
      addTtsHook: "addHook"
    },
    featureFlags: {
      hookV2: true,
      hookDirectorV1: true,
      ttsTimelineV2: false,
      momentScoringV2: true,
      naturalEditDirector: true,
      twoPersonEditing: true,
      youtubeSessionV2: true,
      smartPublishingPlannerV1: true,
      publishingIntelligence: false,
      publishingGuard: false
    }
  };
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function selectedProviderType() {
  return "cloud";
}

function setSelectedProviderType(type) {
  type = "cloud";
  const hidden = $("#providerType");
  if (hidden) hidden.value = type;
  $$(".provider-card").forEach((card) => {
    const isActive = card.dataset.provider === type;
    card.classList.toggle("active", isActive);
    const input = card.querySelector("input[type='radio']");
    if (input) input.checked = isActive;
  });
  applyProviderDefaults(false);
}

function updateTestButtonLabel() {
  const provider = aiProviders[selectedProviderType()] || aiProviders.cloud;
  const button = $("#testApiButton");
  if (button) {
    button.textContent = provider.readonly ? "Hubungkan & Test Cloud" : "Hubungkan & Test Provider";
  }
}

function updateModelHelpText() {
  const provider = aiProviders[selectedProviderType()] || aiProviders.cloud;
  const help = $("#modelHelpText");
  if (!help) return;
  if (provider.readonly) {
    help.textContent = "Model dipilih otomatis oleh Cliper AI Cloud sesuai tugas dan biaya.";
  } else {
    help.textContent = "Contoh: deepseek-chat, gpt-4.1, o4-mini, claude-sonnet-4, llama3.3, auto.";
  }
}

function toast(message, options = {}) {
  const node = $("#toast");
  node.textContent = message;
  const isError = Boolean(options.error);
  node.classList.toggle("error", isError);
  node.setAttribute("role", isError ? "alert" : "status");
  node.setAttribute("aria-live", isError ? "assertive" : "polite");
  node.classList.add("show");
  clearTimeout(node.timer);
  const duration = Number(options.duration) > 0 ? Number(options.duration) : (isError ? 9000 : 2200);
  node.timer = setTimeout(() => {
    node.classList.remove("show", "error");
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
  }, duration);
}

function syncProcessingErrorBanner() {
  const banner = $("#renderErrorBanner");
  if (!banner) return;
  const error = state.processingError;
  // A stale error must not sit above a new active job. The worker status is
  // the source of truth for whether this banner belongs on screen.
  const jobIsError = String($("#jobBadge")?.textContent || "").trim().toLowerCase() === "error";
  const visible = Boolean(error && error.message && jobIsError);
  banner.hidden = !visible;
  banner.classList.toggle("is-visible", visible);
  banner.setAttribute("aria-hidden", visible ? "false" : "true");
  if (!visible) return;
  setText("#renderErrorTitle", error.title || "Proses gagal");
  setText("#renderErrorMessage", error.message);
}

function clearProcessingError() {
  state.processingError = null;
  syncProcessingErrorBanner();
}

function setProcessingError(message, phase = "analyze") {
  const cleanMessage = String(message || "Worker gagal tanpa detail error.").trim();
  state.processingError = {
    phase,
    title: phase === "render" ? "Render dihentikan karena error" : "Analisis dihentikan karena error",
    message: cleanMessage,
  };
  syncProcessingErrorBanner();
}

function showProcessingCancelled(phase = "analyze") {
  clearInterval(state.processingTimer);
  state.processingTimer = null;
  clearProcessingError();
  $("#jobBadge").textContent = "Cancelled";
  $("#cancelJob").disabled = true;
  setText("#renderScreenTitle", phase === "render" ? "Render dibatalkan" : "Analisis dibatalkan");
  setText("#renderScreenSubtitle", "Proses dihentikan oleh user.");
  updateRenderStats({ progress: state.progress || 0, stage: "Cancelled" });
}

function setSettingsTab(tab) {
  const nextTab = tab || "api";
  state.activeSettingsTab = nextTab;
  $$(".settings-tab").forEach((button) => button.classList.toggle("active", button.dataset.settingsTab === nextTab));
  $$(".settings-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `settings-${nextTab}`));
}

function normalizeRequestedClipCount(count, fallback = 4) {
  const numeric = Number(count);
  return Math.max(1, Math.min(10, Math.round(Number.isFinite(numeric) && numeric > 0 ? numeric : fallback)));
}

function syncClipTargetControls(count) {
  const nextCount = normalizeRequestedClipCount(count);
  state.requestedClipCount = nextCount;
  const input = $("#clipCount");
  if (input && Number(input.value) !== nextCount) {
    input.value = String(nextCount);
  }
  $$(".preset-pill").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.presetCount) === nextCount);
  });
  const label = nextCount === 1 ? "Generate 1 Clip" : `Generate ${nextCount} Clips`;
  const span = $("#findMomentsLabel");
  if (span) span.textContent = label;
}

const viewMeta = {
  studio: { title: "Studio", subtitle: "Create amazing short clips with AI" },
  moments: { title: "Moment AI", subtitle: "Review and select discovered story clips" },
  render: { title: "Render Pipeline", subtitle: "Local hardware accelerated video export" },
  outputs: { title: "Output Library", subtitle: "Manage and export finished clips" },
  settings: { title: "Settings", subtitle: "Configure AI, cloud, subtitles, and performance" }
};

function setView(view) {
  state.view = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `view-${view}`));
  const meta = viewMeta[view] || viewMeta.studio;
  setText("#topbarTitle", meta.title);
  setText("#topbarSubtitle", meta.subtitle);
  const activePanel = $(`#view-${view}`);
  if (activePanel) activePanel.scrollTop = 0;
  const workspace = $(".workspace");
  if (workspace) workspace.scrollTop = 0;
  if (view === "render") syncProcessingErrorBanner();
}

function selectedMoments() {
  // Score eligibility decides automatic selection only. A creator may still
  // render any non-rejected candidate after reviewing it manually.
  return momentBank.filter((item) => !item.rejected && state.selectedMoments.has(item.id));
}

function parseTimeInput(value, fallback = 0) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return fallback;
  const parts = raw.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
  }
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  return Math.max(0, parts[0]);
}

function activeMoment() {
  return momentBank.find((item) => item.id === state.activeMomentId && !item.rejected) || momentBank.find((item) => !item.rejected) || null;
}

function videoDurationLimit() {
  return Math.max(1, Number(state.lastAnalysis?.video?.duration || state.videoDuration || $("#momentPreviewVideo")?.duration || 0) || 1);
}

function normalizeMomentTiming(moment) {
  const limit = videoDurationLimit();
  moment.start = Math.max(0, Math.min(Number(moment.start || 0), Math.max(0, limit - 1)));
  moment.end = Math.max(moment.start + 1, Math.min(Number(moment.end || moment.start + 1), limit));
  moment.durationSeconds = Math.max(1, Math.round(moment.end - moment.start));
  moment.duration = `${moment.durationSeconds}s`;
  moment.time = `${formatDuration(moment.start)} - ${formatDuration(moment.end)}`;
  moment.edited = Boolean(moment.edited);
  return moment;
}

function setActiveMoment(id) {
  const moment = momentBank.find((item) => item.id === Number(id) && !item.rejected);
  if (!moment) return;
  state.activeMomentId = moment.id;
  renderMomentReview();
  renderMoments();
}

function transcriptAt(second) {
  const time = Number(second || 0);
  const lead = 0.12;
  const transcript = state.lastTranscript || [];
  const exact = transcript.find((segment) => {
    const start = Number(segment.start || 0);
    const end = Number(segment.end || start);
    return time >= start - lead && time <= end + lead;
  });
  if (exact) return exact;
  return transcript.find((segment) => {
    const start = Number(segment.start || 0);
    const end = Number(segment.end || start);
    return time >= start - 0.25 && time <= end + 0.25;
  }) || null;
}

function normalizeTranscriptSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const numericStarts = segments.map((s) => Number(s.start || 0));
  const maxStart = Math.max(...numericStarts, 0);
  const divisor = maxStart > 10000 ? 1000 : 1; // heuristic: milliseconds -> divide
  return segments
    .map((s) => ({
      ...s,
      start: Number(s.start || 0) / divisor,
      end: Number(s.end || (s.start || 0)) / divisor,
      text: s.text || s.content || ""
    }))
    .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
}

let _subtitleRaf = null;
function cancelSubtitleSync() {
  if (_subtitleRaf) cancelAnimationFrame(_subtitleRaf);
  _subtitleRaf = null;
}

function startSubtitleSync() {
  cancelSubtitleSync();
  const video = $("#momentPreviewVideo");
  if (!video) return;
  const loop = () => {
    const t = Number(video.currentTime || 0);
    const segment = transcriptAt(t);
    const subtitleNode = $("#reviewSubtitlePreview");
    if (subtitleNode) {
      const text = segment?.text || activeMoment()?.transcript || "Preview subtitle";
      subtitleNode.textContent = String(text).trim();
    }
    _subtitleRaf = requestAnimationFrame(loop);
  };
  loop();
}

function transcriptNear(second, direction = 1, windowSeconds = 20) {
  const time = Number(second || 0);
  const low = direction < 0 ? time - windowSeconds : time;
  const high = direction < 0 ? time : time + windowSeconds;
  return (state.lastTranscript || []).filter((segment) => {
    const start = Number(segment.start || 0);
    const end = Number(segment.end || start);
    return end >= low && start <= high;
  });
}

function updateReviewSubtitle() {
  const video = $("#momentPreviewVideo");
  const subtitle = $("#reviewSubtitlePreview");
  if (!video || !subtitle) return;
  const t = Number(video.currentTime || 0);
  const segment = transcriptAt(t);
  const text = segment?.text || activeMoment()?.transcript || "Preview subtitle";
  const words = cleanPreviewWords(text).slice(0, 12);
  let activeIndex = 0;
  if (segment && words.length > 1) {
    const start = Number(segment.start || 0);
    const end = Math.max(Number(segment.end || start), start + 0.25);
    const progress = Math.min(1, Math.max(0, (t - start) / (end - start)));
    activeIndex = Math.min(words.length - 1, Math.floor(progress * words.length));
  }
  subtitle.textContent = "";
  const fragment = document.createDocumentFragment();
  words.forEach((word, index) => {
    const node = document.createElement("span");
    node.textContent = word + (index < words.length - 1 ? " " : "");
    if (index === activeIndex) node.classList.add("active-word");
    fragment.appendChild(node);
  });
  subtitle.appendChild(fragment);
}

function cleanPreviewWords(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function reviewWarningFor(moment) {
  const startSegment = transcriptAt(moment.start);
  const endSegment = transcriptAt(Math.max(moment.start, moment.end - 0.15));
  const warnings = [];
  if (startSegment && Math.abs(Number(startSegment.start || 0) - moment.start) > 1.8) {
    warnings.push("Pembukaan kemungkinan terpotong.");
  }
  if (endSegment && Math.abs(Number(endSegment.end || 0) - moment.end) > 1.8) {
    warnings.push("Cerita kemungkinan belum selesai.");
  }
  return warnings;
}

function syncReviewFields(moment) {
  const limit = videoDurationLimit();
  setValue("#reviewStartInput", formatDuration(moment.start));
  setValue("#reviewEndInput", formatDuration(moment.end));
  setValue("#reviewStartRange", Math.round(moment.start * 10));
  setValue("#reviewEndRange", Math.round(moment.end * 10));
  const startRange = $("#reviewStartRange");
  const endRange = $("#reviewEndRange");
  if (startRange) startRange.max = String(Math.round(limit * 10));
  if (endRange) endRange.max = String(Math.round(limit * 10));
  setText("#reviewRangeStartLabel", formatDuration(moment.start));
  setText("#reviewRangeEndLabel", formatDuration(moment.end));
  setText("#reviewDuration", `Duration ${formatDuration(moment.end - moment.start)} (${Math.round(moment.end - moment.start)}s)`);
  const warningNode = $("#reviewWarning");
  const warnings = reviewWarningFor(moment);
  if (warningNode) {
    warningNode.textContent = warnings.length ? warnings.join(" ") : "✓ Start dan ending terlihat aman.";
    warningNode.classList.toggle("warning", Boolean(warnings.length));
    warningNode.classList.toggle("ok", !warnings.length);
  }
}

function updateMomentTiming(id, start, end, options = {}) {
  const moment = momentBank.find((item) => item.id === Number(id));
  if (!moment) return;
  const limit = videoDurationLimit();
  const minDuration = 3;
  let nextStart = Math.max(0, Math.min(Number(start), limit - minDuration));
  let nextEnd = Math.max(nextStart + minDuration, Math.min(Number(end), limit));
  if (nextEnd - nextStart < minDuration) nextEnd = Math.min(limit, nextStart + minDuration);
  moment.start = Number(nextStart.toFixed(2));
  moment.end = Number(nextEnd.toFixed(2));
  moment.edited = true;
  moment.approved = state.selectedMoments.has(moment.id);
  normalizeMomentTiming(moment);
  if (options.seek !== false) {
    const video = $("#momentPreviewVideo");
    if (video && state.activeMomentId === moment.id) video.currentTime = moment.start;
  }
  syncReviewFields(moment);
  updateCounters();
}

function renderMomentReview() {
  const moment = activeMoment();
  const panel = $("#momentReviewPanel");
  if (!panel) return;
  if (!moment) {
    setText("#reviewClipTitle", "Belum ada moment");
    setText("#reviewHeaderTitle", "Review Momen");
    setText("#reviewScore", "Kualitas -");
    setText("#reviewDuration", "Duration -");
    setText("#reviewStrengths", "Belum ada evidence.");
    setText("#reviewWeaknesses", "Belum ada evidence.");
    return;
  }
  normalizeMomentTiming(moment);
  state.activeMomentId = moment.id;
  const video = $("#momentPreviewVideo");
  const sourcePath = moment.sourcePath || state.lastAnalysis?.video?.source_path || "";
  if (video && sourcePath && video.dataset.sourcePath !== sourcePath) {
    video.src = toFilePreviewSrc(sourcePath);
    video.dataset.sourcePath = sourcePath;
  }
  if (video && sourcePath && Math.abs((video.currentTime || 0) - moment.start) > 1 && video.paused) {
    video.currentTime = moment.start;
  }
  const momentIdx = momentBank.findIndex((m) => m.id === moment.id);
  const displayIdx = momentIdx >= 0 ? momentIdx + 1 : (moment.id || 1);
  setText("#reviewHeaderTitle", `Review Momen #${displayIdx}`);
  setText("#reviewClipTitle", `Clip ${moment.id}: ${moment.title}`);
  setText("#reviewHookTitle", moment.title || "Hook Title");
  setText("#reviewPlayerDurationTag", moment.duration || `${Math.round(moment.end - moment.start)}s`);
  setText(
    "#reviewScore",
    moment.hasScoreEvidence ? `Kualitas ${momentQualityDisplay(moment)}` : "Kualitas perlu ditinjau",
  );
  setText(
    "#reviewReason",
    moment.reason || "Momen ini memiliki hook yang kuat di awal, cerita berkembang dengan jelas, dan ditutup dengan payoff yang memuaskan.",
  );
  setText(
    "#reviewStrengths",
    (moment.selectionReasons || []).join(" · ") || moment.reason || "Evidence kandidat tersedia untuk ditinjau.",
  );
  setText(
    "#reviewWeaknesses",
    (moment.weaknesses || []).join(" · ") || "Tidak ada kelemahan kritis yang terdeteksi.",
  );
  setText("#reviewTranscript", moment.transcript || "Transcript tidak tersedia.");
  setText("#reviewThemeDisplay", moment.category || moment.topic || "Story / Motivation");
  setText("#reviewSourceTitle", state.lastAnalysis?.video?.title || "BAYANGIN SEMUA ORANG TAHU");
  setText("#reviewSourceDuration", formatDuration(state.lastAnalysis?.video?.duration || 2905));
  setText("#reviewConfidence", moment.score ? (moment.score >= 80 ? "High (0.92)" : "Good (0.85)") : "Normal (0.75)");

  const evidence = $("#reviewEvidence");
  if (evidence) {
    const components = momentScoreComponents(moment);
    const items = [
      ["Hook", components.hook],
      ["Story", components.story],
      ["Payoff", components.payoff],
      ["Retention", components.retention],
      ["Standalone", components.standalone],
    ];
    evidence.innerHTML = items
      .map(([label, value]) => `<span><small>${label}</small><strong>${formatMomentMetric(value)}</strong></span>`)
      .join("");
  }
  const storyRolesEl = $("#reviewStoryRoles");
  if (storyRolesEl) {
    const components = momentScoreComponents(moment);
    const setupPct = Math.round(Number(components.hook || 80));
    const conflictPct = Math.round(Number(components.retention || 70));
    const answerPct = Math.round(Number(components.story || 90));
    const insightPct = Math.round(Number(components.standalone || 80));
    const payoffPct = Math.round(Number(components.payoff || 95));
    const conclusionPct = Math.round(Number(components.story || 80));
    storyRolesEl.innerHTML = `
      <div class="role-progress-item">
        <span>Setup</span>
        <div class="role-bar"><span style="width: ${Math.max(10, setupPct)}%;"></span></div>
        <small>${setupPct}%</small>
      </div>
      <div class="role-progress-item">
        <span>Conflict</span>
        <div class="role-bar"><span style="width: ${Math.max(10, conflictPct)}%;"></span></div>
        <small>${conflictPct}%</small>
      </div>
      <div class="role-progress-item">
        <span>Answer</span>
        <div class="role-bar"><span style="width: ${Math.max(10, answerPct)}%;"></span></div>
        <small>${answerPct}%</small>
      </div>
      <div class="role-progress-item">
        <span>Insight</span>
        <div class="role-bar"><span style="width: ${Math.max(10, insightPct)}%;"></span></div>
        <small>${insightPct}%</small>
      </div>
      <div class="role-progress-item">
        <span>Payoff</span>
        <div class="role-bar"><span style="width: ${Math.max(10, payoffPct)}%;"></span></div>
        <small>${payoffPct}%</small>
      </div>
      <div class="role-progress-item">
        <span>Conclusion</span>
        <div class="role-bar"><span style="width: ${Math.max(10, conclusionPct)}%;"></span></div>
        <small>${conclusionPct}%</small>
      </div>
    `;
  }
  syncReviewFields(moment);
  updateReviewSubtitle();
  // ensure transcript timing normalized for sync
  if (Array.isArray(state.lastTranscript) && state.lastTranscript.length) {
    state.lastTranscript = normalizeTranscriptSegments(state.lastTranscript);
  }
  startSubtitleSync();
}

function suggestBetterBoundary(type) {
  const moment = activeMoment();
  if (!moment) return;
  if (type === "start") {
    const nearby = transcriptNear(moment.start, -1, 20);
    const first = nearby.find((segment) => Number(segment.end || 0) > moment.start - 18) || nearby[0];
    if (first) {
      updateMomentTiming(moment.id, Math.max(0, Number(first.start || moment.start)), moment.end);
      toast("Start disesuaikan ke awal kalimat terdekat");
    }
    return;
  }
  const nearby = transcriptNear(moment.end, 1, 20);
  const last = nearby.find((segment) => /[.!?…]$/.test(String(segment.text || "").trim())) || nearby[nearby.length - 1];
  if (last) {
    updateMomentTiming(moment.id, moment.start, Math.min(videoDurationLimit(), Number(last.end || moment.end)));
    toast("Ending disesuaikan ke akhir kalimat terdekat");
  }
}

function regenerateActiveMoment() {
  const moment = activeMoment();
  if (!moment) return;
  const existing = momentBank.filter((item) => !item.rejected);
  const duration = Math.max(20, Math.min(95, Number(moment.end - moment.start || 45)));
  const offset = duration + 12;
  const limit = videoDurationLimit();
  let start = Math.min(Math.max(0, moment.end + 8), Math.max(0, limit - duration));
  if (existing.some((item) => Math.abs(Number(item.start || 0) - start) < 6)) {
    start = Math.max(0, moment.start - offset);
  }
  const end = Math.min(limit, start + duration);
  const text = transcriptNear(start, 1, duration).map((segment) => segment.text).join(" ").trim() || moment.transcript;
  const replacement = normalizeMomentForUi({
    ...moment,
    id: Date.now(),
    start,
    end,
    transcript: text,
    title: text ? text.split(/\s+/).slice(0, 10).join(" ") : `${moment.title} alternatif`,
    titleSuggestion: text ? text.split(/\s+/).slice(0, 10).join(" ") : `${moment.title} alternatif`,
    ai_selected: false,
    segment_type: "Alternative",
    reason: "Alternatif boundary lokal. Jalankan analisa ulang untuk memperoleh score evidence-based.",
    score: null,
    metrics: null,
    scoreProvenance: null,
    manualReview: true,
    evidenceGate: false,
    qualityTier: "review",
    edited: true
  }, momentBank.length, state.lastAnalysis?.video || {});
  moment.rejected = true;
  momentBank.push(replacement);
  state.selectedMoments.delete(moment.id);
  state.selectedMoments.add(replacement.id);
  state.activeMomentId = replacement.id;
  renderMomentReview();
  renderMoments();
  toast("Alternatif moment dibuat. Boundary alternatif perlu dianalisis ulang.");
}

function updateCounters() {
  const count = selectedMoments().length;
  const visible = filteredMoments();
  const duration = Math.max(0, Number(state.videoDuration || state.lastAnalysis?.video?.duration || 0));
  $("#clipCounter").textContent = `${count} clip dipilih`;
  $("#previewDuration").textContent = duration
    ? `${formatDuration(duration)}${state.lastAnalysis ? ` · ${count} clip dipilih` : ""}`
    : "Durasi belum dimuat";
  $("#captionMetric").textContent = state.lastAnalysis ? ($("#captionStyle") ? $("#captionStyle").value : "Caption aktif") : "Belum diproses";

  // Modern bottom action bar bindings
  const bottomSelectionText = $("#bottomSelectionText");
  if (bottomSelectionText) {
    bottomSelectionText.textContent = `Terpilih ${count} dari ${visible.length || momentBank.length} momen`;
  }
  const bottomSelectAllToggle = $("#bottomSelectAllToggle");
  if (bottomSelectAllToggle) {
    bottomSelectAllToggle.checked = visible.length > 0 && visible.every((item) => state.selectedMoments.has(item.id));
  }
  const bottomTotalDuration = $("#bottomTotalDuration");
  if (bottomTotalDuration) {
    const selectedList = selectedMoments();
    const totalSecs = selectedList.reduce((acc, m) => acc + (Number(m.end - m.start) || 0), 0);
    bottomTotalDuration.textContent = totalSecs > 0 ? formatDuration(totalSecs) : "0s";
  }
  const bottomRenderSelectedBtn = $("#bottomRenderSelectedBtn");
  const bottomRenderSelectedLabel = $("#bottomRenderSelectedLabel");
  if (bottomRenderSelectedBtn && bottomRenderSelectedLabel) {
    bottomRenderSelectedLabel.textContent = `Lanjut ke Render (${count})`;
    bottomRenderSelectedBtn.disabled = count === 0;
  }
  updateProcessButtons();
}

function aiFeatureConfig() {
  return {
    highlight: Boolean($("#aiHighlightToggle")?.checked),
    hook: Boolean($("#aiHookToggle")?.checked),
    caption: Boolean($("#aiCaptionToggle")?.checked),
    title: Boolean($("#aiTitleToggle")?.checked)
  };
}

function momentScoreOutOfTen(item) {
  // Prefer public_score from backend (non-linear, evidence-calibrated mapping)
  const obj = item && typeof item === "object" ? item : {};
  if (Number.isFinite(obj.public_score) && obj.public_score > 0) {
    return obj.public_score;
  }
  // Fallback: non-linear mapping consistent with highlight_engine.public_score_out_of_ten
  const s = Number(obj.score ?? item ?? 0);
  if (!Number.isFinite(s) || s <= 0) return 0;
  if (s >= 94) return 10;
  if (s >= 85) return 9;
  if (s >= 75) return 8;
  if (s >= 65) return 7;
  if (s >= 55) return 6;
  return 5;
}

function formatMomentMetric10(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "-";
  return String(Math.max(1, Math.min(10, Math.round(numeric / 10))));
}

function momentQuality(item) {
  const tier = String(item.qualityTier || item.quality_tier || "").trim().toLowerCase();
  if (tier === "strong" || tier === "excellent") return { key: "excellent", label: "Sangat Direkomendasikan", tierClass: "tier-sangat-rekomendasi" };
  if (tier === "good") return { key: "good", label: "Direkomendasikan", tierClass: "tier-rekomendasi" };
  if (tier === "fair" || tier === "layak") return { key: "good", label: "Layak", tierClass: "tier-layak" };
  if (tier === "review" || tier === "optional") return { key: "review", label: "Opsional", tierClass: "tier-opsional" };
  if (tier === "reject") return { key: "reject", label: "Tidak layak", tierClass: "tier-reject" };

  const evidenceGate = item.evidenceGate ?? item.evidence_gate;
  if (item.manualReview || evidenceGate === false) return { key: "review", label: "Low Priority / Review", tierClass: "tier-opsional" };
  const s10 = momentScoreOutOfTen(item);
  if (s10 >= 9) return { key: "excellent", label: "Sangat Direkomendasikan", tierClass: "tier-sangat-rekomendasi" };
  if (s10 === 8) return { key: "good", label: "Direkomendasikan", tierClass: "tier-rekomendasi" };
  if (s10 === 7) return { key: "good", label: "Layak", tierClass: "tier-layak" };
  if (s10 === 6) return { key: "review", label: "Opsional", tierClass: "tier-opsional" };
  return { key: "review", label: "Low Priority / Review", tierClass: "tier-opsional" };
}

function momentQualityDisplay(item) {
  const score = momentScoreOutOfTen(item || {});
  return score > 0 ? `${score}/10` : "Perlu ditinjau";
}

function formatMomentMetric(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? String(Math.round(numeric)) : "-";
}

function momentScoreComponents(item) {
  const metrics = item?.metrics && typeof item.metrics === "object" ? item.metrics : {};
  const provenance = item?.scoreProvenance || item?.score_provenance || metrics.score_provenance || {};
  const scorecard = metrics.scorecard || provenance.scorecard || {};
  const arc = scorecard.arc && typeof scorecard.arc === "object" ? scorecard.arc : {};
  const dimensions = item?.qualityDimensions || metrics.quality_dimensions || scorecard.dimensions || {};

  return {
    hook: dimensions.hookPotential ?? metrics.hook,
    story: dimensions.storyCompleteness ?? metrics.story_complete ?? metrics.flow,
    payoff: dimensions.payoffStrength ?? metrics.payoff ?? arc.payoff,
    retention: dimensions.retentionPotential ?? metrics.retention_predictor ?? arc.retention_proxy,
    standalone: dimensions.contextClarity ?? metrics.standalone ?? arc.standalone,
  };
}

function momentReviewLabel(item) {
  const reviewerStatus = String(item?.reviewer_status || item?.reviewerStatus || "").trim().toLowerCase();
  if (reviewerStatus === "approved") return "AI review tersedia";
  if (reviewerStatus === "unavailable" || reviewerStatus === "missing") return "AI review tidak tersedia";
  if (item?.ai_selected) return "Dipilih AI";
  return "Evidence lokal";
}

function applyMomentDisplayPolicy() {
  const visible = momentBank.filter((item) => !item.rejected);
  const qualified = visible.filter((item) =>
    ["excellent", "good"].includes(momentQuality(item).key)
  );
  state.momentQualityFilter = qualified.length ? "qualified" : "all";
  const control = $("#momentQualityFilter");
  if (control) control.value = state.momentQualityFilter;
}
function filteredMoments() {
  const query = String(state.momentSearch || "").trim().toLowerCase();
  const qualityFilter = state.momentQualityFilter || "all";
  const themeFilter = state.momentThemeFilter || "all";
  const items = momentBank.filter((item) => {
    if (item.rejected) return false;
    if (momentQuality(item).key === "reject") return false;
    if (qualityFilter === "selected" && !state.selectedMoments.has(item.id)) return false;
    if (qualityFilter === "auto" && !item.autoRender) return false;
    if (qualityFilter === "recommended" && (item.autoRender || !item.renderEligible)) return false;
    if (qualityFilter === "qualified" && !["excellent", "good"].includes(momentQuality(item).key)) return false;
    if (qualityFilter === "excellent" && momentQuality(item).key !== "excellent") return false;
    if (qualityFilter === "good" && !["excellent", "good"].includes(momentQuality(item).key)) return false;
    if (qualityFilter === "review" && momentQuality(item).key !== "review") return false;
    if (!["all", "selected", "auto", "recommended", "qualified", "excellent", "good", "review"].includes(qualityFilter) && momentQuality(item).key !== qualityFilter) return false;
    if (themeFilter !== "all") {
      const themeHaystack = `${item.category || ""} ${item.topic || ""}`.toLowerCase();
      if (!themeHaystack.includes(themeFilter.toLowerCase())) return false;
    }
    if (!query) return true;
    const haystack = `${item.title || ""} ${item.hook || ""} ${item.transcript || ""} ${item.topic || ""} ${item.category || ""}`.toLowerCase();
    return haystack.includes(query);
  });
  const metric = (item, key, fallback = 0) => Number(item.metrics?.[key] ?? fallback);
  return items.sort((left, right) => {
    if (state.momentSort === "hook") return metric(right, "hook") - metric(left, "hook");
    if (state.momentSort === "story") return metric(right, "story_complete", metric(right, "flow")) - metric(left, "story_complete", metric(left, "flow"));
    if (state.momentSort === "payoff") return metric(right, "payoff") - metric(left, "payoff");
    if (state.momentSort === "shortest") return left.durationSeconds - right.durationSeconds;
    if (state.momentSort === "timeline") return left.start - right.start;
    return right.score - left.score;
  });
}

function renderMoments() {
  const grid = $("#momentGrid");
  const visibleMoments = filteredMoments();
  const eligibleMoments = momentBank.filter((item) => !item.rejected && item.renderEligible);
  const autoCount = eligibleMoments.filter((item) => item.autoRender).length;
  const reviewCount = eligibleMoments.filter((item) => !item.autoRender).length;
  const requested = Number($("#clipCount")?.value || state.requestedClipCount || 4);
  const diag = state.lastAnalysis?.diagnostics || {};
  const totalFound = diag.discoveredCandidates || momentBank.length;
  const targetOriginal = diag.requestedClips || requested;
  let countSummary;
  if (visibleMoments.length > 0 && visibleMoments.length >= targetOriginal) {
    const extraCount = visibleMoments.length - targetOriginal;
    countSummary = `${visibleMoments.length} momen terbaik ditemukan`;
    const subParts = [`Target awal ${targetOriginal} clip`, `${totalFound} kandidat dianalisis`];
    if (extraCount > 0) subParts.push(`${extraCount} cerita tambahan yang layak`);
    countSummary += ` (${subParts.join(' \u00b7 ')})`;
  } else if (visibleMoments.length > 0) {
    countSummary = `${visibleMoments.length} momen terbaik ditemukan · Anda meminta ${targetOriginal} clip; kandidat lemah tidak ditambahkan`;
  } else {
    countSummary = `${autoCount} otomatis · ${reviewCount} rekomendasi · ${visibleMoments.length} tampil`;
  }
  setText("#momentResultCount", countSummary);

  // Update Summary Bar
  setText("#momentSummaryBestCount", String(visibleMoments.length || (momentBank.length ? momentBank.length : 0)));
  const targetEl = $("#momentSummaryTarget");
  if (targetEl) targetEl.innerHTML = `${targetOriginal} <span class="dim-unit">clips</span>`;
  setText("#momentSummaryAnalyzed", String(totalFound || (momentBank.length ? momentBank.length : 0)));
  const totalVisibleSecs = visibleMoments.reduce((acc, m) => acc + (Number(m.end - m.start) || 0), 0);
  setText("#momentSummaryTotalDuration", totalVisibleSecs > 0 ? formatDuration(totalVisibleSecs) : "0s");

  const selectAllButton = $("#selectAllButton");
  if (selectAllButton) {
    const allVisibleSelected = visibleMoments.length > 0 && visibleMoments.every((item) => state.selectedMoments.has(item.id));
    selectAllButton.textContent = allVisibleSelected ? "Kosongkan terlihat" : "Pilih semua terlihat";
  }
  if (visibleMoments.length === 0) {
    const analysisFinished = Boolean(state.lastAnalysis);
    grid.innerHTML = `
      <div class="empty-state wide">
        <strong>${analysisFinished ? "Belum ada moment yang lolos validasi." : "Masukkan link YouTube untuk menganalisa moment terbaik."}</strong>
        <span>${analysisFinished ? "Cliper tidak menambahkan kandidat lemah hanya untuk memenuhi target. Coba area video lain bila diperlukan." : "Moment AI muncul setelah metadata, transcript, story, dan scoring selesai dianalisis."}</span>
      </div>
    `;
    updateCounters();
    return;
  }
  grid.innerHTML = visibleMoments
    .map((item, idx) => {
      const checked = state.selectedMoments.has(item.id);
      const active = state.activeMomentId === item.id;
      const quality = momentQuality(item);
      const thumbnail = item.previewThumbnail ? toFilePreviewSrc(item.previewThumbnail) : "";
      const components = momentScoreComponents(item);
      const hookScore10 = formatMomentMetric10(components.hook);
      const storyScore10 = formatMomentMetric10(components.story);
      const payoffScore10 = formatMomentMetric10(components.payoff);
      const displayScore = momentQualityDisplay(item);
      const themeLabel = item.category || item.topic || "Story";
      const whyReason = item.reason || "Story lengkap dengan payoff yang kuat dan memberi inspirasi.";
      const displayIdx = idx + 1;

      return `
        <article class="moment-card-v12 quality-${quality.key} ${checked ? "selected" : ""} ${active ? "active-review" : ""} ${item.lowQuality ? "low-quality" : ""}" data-moment-row="${item.id}" tabindex="0">
          <div class="moment-thumb-wrap">
            ${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" />` : `<div class="moment-thumb-placeholder">🎬</div>`}
            <span class="moment-score-num-badge">${escapeHtml(displayScore)}</span>
            <div class="moment-top-right-bar">
              <span class="moment-tier-pill ${quality.tierClass || ''}">${escapeHtml(quality.label)}</span>
              <button type="button" class="card-select-checkbox ${checked ? "checked" : ""}" data-toggle-moment-btn="${item.id}" aria-label="Pilih clip">${checked ? "✓" : ""}</button>
            </div>
            <span class="moment-time-tag">${escapeHtml(item.duration || item.time)}</span>
          </div>
          <div class="moment-content-box">
            <div class="moment-title-row-card">
              <span class="moment-num-chip">${displayIdx}</span>
              <h3>${escapeHtml(item.title)}</h3>
            </div>
            <div class="moment-time-duration">${escapeHtml(item.time)}</div>
            <div class="moment-metrics-row">
              <span class="metric-pill-tag">Hook ${hookScore10}</span>
              <span class="metric-pill-tag">Story ${storyScore10}</span>
              <span class="metric-pill-tag">Payoff ${payoffScore10}</span>
              <span class="metric-pill-tag theme-tag">${escapeHtml(themeLabel)}</span>
            </div>
            <div class="moment-why-box">${escapeHtml(whyReason)}</div>
            <div class="moment-card-actions">
              <button type="button" class="card-action-btn card-preview-btn" data-preview-moment="${item.id}">Preview</button>
              <button type="button" class="card-action-btn card-select-btn ${checked ? "selected" : ""}" data-toggle-moment-btn="${item.id}">${checked ? "✓ Selected" : "Select"}</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
  updateCounters();
}

function normalizeMomentForUi(item, index, video = {}) {
  const start = Number(item.start || 0);
  const end = Number(item.end || 0);
  const rawDuration = Number(item.duration || (end > start ? end - start : 0));
  const durationSeconds = Math.max(0, Math.round(rawDuration));
  const rawScore = Number(item.score);
  const metrics = item.metrics && typeof item.metrics === "object" ? item.metrics : null;
  const scoreProvenance = item.scoreProvenance || item.score_provenance || metrics?.score_provenance;
  const hasScoreEvidence = Number.isFinite(rawScore) && rawScore > 0 && Boolean(metrics || scoreProvenance);
  const score = hasScoreEvidence ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  const type = item.ai_selected ? (item.ai_source || "AI Provider") : (item.segment_type || item.type || "Local Heuristic");
  const title = item.titleSuggestion || item.title || `Moment ${index + 1}`;
  const evidenceGate = item.ai_evidence_gate === undefined ? item.evidence_gate : item.ai_evidence_gate;
  const reviewerStatus = String(item.reviewer_status || "").trim().toLowerCase();
  const manualReview = item.manual_review_candidate === true
    || item.manualReview === true
    || ["rejected", "missing", "unavailable"].includes(reviewerStatus);
  const qualityTier = String(item.quality_tier || item.qualityTier || "").trim().toLowerCase();

  return {
    ...item,
    id: item.id || index + 1,
    start,
    end,
    score,
    hasScoreEvidence,
    type,
    title,
    durationSeconds,
    duration: `${durationSeconds}s`,
    time: item.time || `${formatDuration(start)} - ${formatDuration(end)}`,
    previewThumbnail: item.preview_thumbnail_path || video.thumbnail || "",
    titleSuggestion: item.titleSuggestion || item.hook || title,
    reason: item.reason || "",
    selectionReasons: Array.isArray(item.selectionReasons)
      ? item.selectionReasons
      : Array.isArray(item.selection_reasons) ? item.selection_reasons : [],
    weaknesses: Array.isArray(item.weaknesses) ? item.weaknesses : [],
    qualityDimensions: item.qualityDimensions || item.quality_dimensions || metrics?.quality_dimensions || {},
    category: item.category || item.segment_type || "Insight",
    speaker: item.speaker || item.speaker_label || "Speaker auto",
    sourcePath: item.source_path || item.sourcePath || video.source_path || "",
    sourceInfo: item.source_info || item.sourceInfo || null,
    transcriptSegments: Array.isArray(item.transcript_segments) ? item.transcript_segments : [],
    metrics,
    grade: item.grade || "",
    priority: item.priority || (score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "LOW" : "REJECT"),
    qualityTier,
    evidenceGate,
    autoRender: item.auto_render === true && score >= AUTO_SELECT_MIN_SCORE && evidenceGate === true && !manualReview,
    manualReview,
    renderEligible: manualReview || (item.render_eligible !== false && score >= MANUAL_RENDER_MIN_SCORE),
    lowQuality: item.low_quality === true || score < MANUAL_RENDER_MIN_SCORE
  };
}

function collectPayload() {
  const aiPayload = providerPayload();
  const productionPreset = getProductionRenderPreset();
  const outputQualityProfile = fieldValue("outputQualityProfile", "balanced");
  const qualityPreset = getOutputQualityPreset(outputQualityProfile);
  const creditTextEnabled = productionPreset.creditText;
  const watermarkEnabled = Boolean(fieldValue("watermarkEnabled", false) && fieldValue("watermarkInOutput", false));
  const logoPath = fieldValue("logoAssetPath", "").trim();
  const logoOverlayEnabled = Boolean(watermarkEnabled && logoPath);
  const sourceChannel = state.lastAnalysis?.video?.channel || "YouTube";
  const watermarkText = $("#watermarkText")?.value?.trim() || (logoOverlayEnabled ? "Cliper Studio Plus" : "");
  const requestedClipCount = normalizeRequestedClipCount($("#clipCount").value);
  const settingsContractVersion = Number(state.settingsContract?.version || 1);
  return {
    sourceMode: "youtube",
    url: $("#youtubeUrl").value.trim(),
    // Keep the source duration explicit for Cloud job reservation. The Worker
    // also receives the selected duration when a range is chosen below.
    videoDuration: Math.max(0, Number(state.videoDuration || state.lastAnalysis?.video?.duration || 0)),
    clipCount: requestedClipCount,
    allRecommendedClips: false,
    fullAutoMode: true,
    autoClipCount: false,
    autoRenderMinScore: AUTO_SELECT_MIN_SCORE,
    subtitleLang: $("#subtitleLang").value,
    minDuration: Number(fieldValue("minDuration", 30)),
    targetDuration: Number(fieldValue("targetDuration", 75)),
    maxDuration: Number(fieldValue("maxDuration", 180)),
    autoDuration: true,
    selectionMode: fieldValue("selectionMode", "full"),
    rangeStart: fieldValue("rangeStart", ""),
    rangeEnd: fieldValue("rangeEnd", ""),
    multipleRanges: fieldValue("multipleRanges", ""),
    scoreMode: "Content-aware editor score",
    cookiesPath: state.cookiesPath,
    outputFolder: $("#outputFolder")?.value || "outputs/clips",
    projectName: $("#projectName")?.value || "Cliper Studio Plus",
    ffmpegPath: $("#ffmpegPath")?.value || "",
    ffprobePath: $("#ffprobePath")?.value || "",
    outputQualityProfile,
    renderVideoBitrate: qualityPreset.videoBitrate,
    renderVideoMaxrate: qualityPreset.videoMaxrate,
    renderVideoBufsize: qualityPreset.videoBufsize,
    renderAudioBitrate: qualityPreset.audioBitrate,
    resolutionProfile: $("#resolutionProfile")?.value,
    crfProfile: $("#crfProfile")?.value,
    fpsProfile: $("#fpsProfile")?.value,
    settingsContractVersion,
    featureFlags: { ...(state.settingsContract?.featureFlags || {}) },
    rendererSettings: { ...productionPreset },
    settingsRequested: { ...productionPreset },
    autoVideoEnhancement: productionPreset.autoVideoEnhancement,
    gpuAcceleration: productionPreset.gpuAcceleration,
    activeEncoder: $("#activeEncoder")?.textContent,
    productionPreset,
    transformativeMode: false,
    introContext: false,
    editorialDisclaimer: true,
    noReuploadMode: true,
    smartCrop: productionPreset.smartCrop,
    dynamicZoom: productionPreset.dynamicZoom,
    addCaptions: productionPreset.addCaptions,
    burnSubtitle: productionPreset.burnSubtitle,
    autoCut: productionPreset.autoCut,
    addHook: productionPreset.addHook,
    addTtsHook: productionPreset.addTtsHook,
    hookDuration: $("#hookDuration")?.value,
    hookLayout: $("#hookLayout")?.value || "auto",
    contextDuration: 1.8,
    faceTrack: productionPreset.faceTrack,
    audioEnhance: productionPreset.audioEnhance,
    creditText: creditTextEnabled,
    sourceCreditText: `Source: ${sourceChannel}`,
    logoOverlay: logoOverlayEnabled,
    logoPath,
    logoX: percentField("logoX", 84),
    logoY: percentField("logoY", 12),
    logoScale: numberField("logoScale", 18),
    logoOpacity: numberField("logoOpacity", 90),
    logoRotation: numberField("logoRotation", 0),
    exportThumbnailPreview: productionPreset.exportThumbnailPreview,
    addWatermark: watermarkEnabled,
    watermarkText,
    watermarkOpacity: $("#watermarkOpacity")?.value,
    watermarkPosition: $("#watermarkPosition")?.value,
    watermarkTextX: percentField("watermarkTextX", 82),
    watermarkTextY: percentField("watermarkTextY", 20),
    watermarkTextSize: numberField("watermarkTextSize", 42),
    watermarkTextColor: fieldValue("watermarkTextColor", "#ffffff"),
    watermarkTextStroke: fieldValue("watermarkTextStroke", "#000000"),
    watermarkTextShadow: numberField("watermarkTextShadow", 2),
    watermarkFontFamily: fieldValue("watermarkFontFamily", "Arial Black"),
    watermarkFontPath: fieldValue("watermarkFontPath", ""),
    writeMetadata: productionPreset.writeMetadata,
    metadataToggle: productionPreset.metadataToggle,
    providerType: aiPayload.providerType,
    baseUrl: aiPayload.baseUrl,
    apiKey: aiPayload.apiKey,
    model: aiPayload.model,
    highlightModel: aiPayload.model,
    moduleModels: aiPayload.moduleModels,
    maxTokensByModule: aiPayload.maxTokensByModule,
    timeoutMsByModule: aiPayload.timeoutMsByModule,
    aiRetryByModule: aiPayload.aiRetryByModule,
    timeoutMs: aiPayload.timeoutMs,
    aiFeatures: aiPayload.aiFeatures,
    useHighlightAI: aiPayload.aiFeatures.highlight,
    useHookAI: aiPayload.aiFeatures.hook,
    useCaptionAI: aiPayload.aiFeatures.caption,
    useTitleAI: aiPayload.aiFeatures.title,
    useTtsAI: aiPayload.aiFeatures.tts,
    captionStyle: $("#captionStyle")?.value || "TikTok style",
    subtitlePreviewText: fieldValue("subtitlePreviewInput", "TAPI GUE HERAN"),
    subtitleWordHighlight: fieldValue("subtitleWordHighlightToggle", true),
    subtitleFontFamily: fieldValue("subtitleFontFamily", "Arial Black"),
    subtitleFontPath: fieldValue("subtitleFontPath", ""),
    subtitleFontSize: numberField("subtitleFontSize", 84),
    subtitleX: percentField("subtitleX", 50),
    subtitleY: percentField("subtitleY", 82),
    subtitlePrimaryColor: fieldValue("subtitlePrimaryColor", "#ffffff"),
    subtitleActiveColor: fieldValue("subtitleActiveColor", "#ffe600"),
    subtitleStrokeColor: fieldValue("subtitleStrokeColor", "#000000"),
    subtitleShadow: numberField("subtitleShadow", 3),
    subtitleAnimation: fieldValue("subtitleAnimation", "Scale"),
    subtitleLetterSpacing: numberField("subtitleLetterSpacing", 1.1),
    subtitlePreset: fieldValue("subtitlePreset", "capcut"),
    overlayGeometryVersion: 2,
    formatProfile: $("#formatProfile")?.value
  };
}

function selectedMomentPayload() {
  return selectedMoments().map((item) => ({
    id: item.id,
    title: item.title,
    start: item.start,
    end: item.end,
    duration: Number(item.durationSeconds || Math.max(0, Math.round(Number(item.end || 0) - Number(item.start || 0))) || 30),
    time: item.time,
    score: Math.max(0, Math.min(100, Math.round(Number(item.score || 0)))),
    type: item.type,
    transcript: item.transcript,
    titleSuggestion: item.titleSuggestion,
    hook: item.hook,
    reason: item.reason,
    metrics: item.metrics,
    grade: item.grade,
    category: item.category,
    speaker: item.speaker,
    layout: item.layout,
    source_path: item.sourcePath || "",
    source_info: item.sourceInfo || null,
    transcript_segments: item.transcriptSegments || [],
    ai_selected: item.ai_selected,
    approved: true,
    edited: Boolean(item.edited)
  }));
}

function stepDefinitions() {
  return state.jobMode === "analyze" ? analysisSteps : renderStepsConfig;
}

function normalizeStageId(stage = "") {
  const value = String(stage).toLowerCase();
  if (state.jobMode === "analyze") {
    if (value.includes("subtitle") || value.includes("metadata")) return "subtitle";
    if (value.includes("moment") || value.includes("ai") || value.includes("done")) return "ai";
  }
  if (value.includes("download") || value.includes("section") || value.includes("cache") || value.includes("metadata") || value.includes("prepare")) return "download";
  if (value.includes("portrait") || value.includes("face") || value.includes("crop") || value.includes("encode")) return "portrait";
  if (value.includes("hook")) return "hook";
  if (value.includes("caption") || value.includes("subtitle")) return "caption";
  if (value.includes("watermark") || value.includes("credit")) return "watermark";
  return "";
}

function resetStepStatus(mode) {
  state.jobMode = mode;
  state.renderStepStatus = {};
  stepDefinitions().forEach((step) => {
    state.renderStepStatus[step.id] = "pending";
  });
}

function setActiveStep(stage, status = "active") {
  const id = normalizeStageId(stage);
  if (!id) return;
  const steps = stepDefinitions();
  const index = steps.findIndex((step) => step.id === id);
  steps.forEach((step, stepIndex) => {
    if (stepIndex < index && state.renderStepStatus[step.id] !== "error") {
      state.renderStepStatus[step.id] = "done";
    }
  });
  state.renderStepStatus[id] = status;
}

function renderSteps() {
  const list = $("#stepList");
  if (!list) return;
  const steps = stepDefinitions();
  list.innerHTML = steps
    .map((step) => {
      const status = state.renderStepStatus[step.id] || "pending";
      const tag = status === "error" ? `<em class="step-tag error">Error</em>` : status === "done" ? `<em class="step-tag done">Done</em>` : "";
      return `<li class="${status}"><span class="step-dot"></span><span>${step.label}</span>${tag}</li>`;
    })
    .join("");
  const progressBar = $("#progressBar");
  if (progressBar) progressBar.style.width = `${state.progress}%`;
  setText("#progressPercent", `${Math.round(state.progress)}%`);
}

function renderLogs() {
  $("#logOutput").textContent = state.logLines.slice(-120).join("\n");
}

function pushLog(message) {
  state.logLines.push(message);
  renderLogs();
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function setValue(selector, value) {
  const node = $(selector);
  if (!node || value === undefined || value === null) return;
  if (node.type === "checkbox") {
    node.checked = Boolean(value);
    return;
  }
  node.value = value;
}

function fieldValue(id, fallback = "") {
  const node = $(`#${id}`);
  if (!node) return fallback;
  return node.type === "checkbox" ? node.checked : node.value;
}

function numberField(id, fallback = 0) {
  const value = Number(fieldValue(id, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function percentField(id, fallback = 50) {
  return Math.max(0, Math.min(100, numberField(id, fallback)));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toFilePreviewSrc(value) {
  const text = String(value || "").trim();
  if (!text || /^(https?:|file:|data:|assets\/)/i.test(text)) return text;
  return `file:///${text.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function fileNameFromPath(value) {
  return String(value || "").split(/[\\/]/).pop() || String(value || "");
}

function setSourceMode() {
  setText("#modeBadge", "Local worker");
}

function analysisDuration() {
  return Math.max(0, Number(state.videoDuration || state.lastAnalysis?.video?.duration || 0));
}

function parseAnalysisTimeValue(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length > 3 || parts.some((part) => !part.trim())) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (numbers.length >= 2 && numbers[numbers.length - 1] >= 60) return null;
  if (numbers.length === 3 && numbers[1] >= 60) return null;
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0];
}

function parseMultipleAnalysisRangeInput(value, duration) {
  const ranges = [];
  const invalidEntries = [];
  for (const item of String(value || "").split(/\n|,/)) {
    const text = item.trim();
    if (!text) continue;
    if (!text.includes("-")) {
      invalidEntries.push(text);
      continue;
    }
    const [left, right] = text.split("-", 2);
    const parsedStart = parseAnalysisTimeValue(left);
    const parsedEnd = parseAnalysisTimeValue(right);
    if (parsedStart === null || parsedEnd === null) {
      invalidEntries.push(text);
      continue;
    }
    const start = Math.max(0, Math.min(parsedStart, duration));
    const end = Math.max(0, Math.min(parsedEnd, duration));
    if (end > start) ranges.push([start, end]);
    else invalidEntries.push(text);
  }
  const mergedRanges = ranges
    .sort((left, right) => left[0] - right[0])
    .reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) {
        previous[1] = Math.max(previous[1], range[1]);
      } else {
        merged.push([...range]);
      }
      return merged;
    }, []);
  return { ranges: mergedRanges, invalidEntries };
}

function parseMultipleAnalysisRanges(value, duration) {
  return parseMultipleAnalysisRangeInput(value, duration).ranges;
}

function currentAnalysisSelection() {
  const mode = fieldValue("selectionMode", "full");
  const duration = analysisDuration();
  if (!duration) {
    return { mode, duration: 0, ranges: [], valid: false, message: "Tunggu metadata dan durasi video selesai dimuat." };
  }
  if (mode === "full") {
    return { mode, duration, ranges: [], valid: true, selectedDuration: duration };
  }
  if (mode === "multiple") {
    const parsed = parseMultipleAnalysisRangeInput(fieldValue("multipleRanges", ""), duration);
    const ranges = parsed.ranges;
    if (parsed.invalidEntries.length) {
      return {
        mode,
        duration,
        ranges: [],
        valid: false,
        message: `Perbaiki ${parsed.invalidEntries.length} multiple range yang tidak valid. Gunakan format 00:10:00-00:20:00.`,
      };
    }
    if (!ranges.length) {
      return { mode, duration, ranges: [], valid: false, message: "Masukkan minimal satu multiple range yang valid." };
    }
    return {
      mode,
      duration,
      ranges,
      valid: true,
      selectedDuration: ranges.reduce((total, [start, end]) => total + (end - start), 0),
    };
  }
  const parsedStart = parseAnalysisTimeValue(fieldValue("rangeStart", ""));
  const parsedEnd = parseAnalysisTimeValue(fieldValue("rangeEnd", ""));
  if (parsedStart === null || parsedEnd === null) {
    return { mode, duration, ranges: [], valid: false, message: "Format Start/End tidak valid. Gunakan MM:SS atau HH:MM:SS." };
  }
  const start = Math.max(0, Math.min(parsedStart, duration));
  const end = Math.max(0, Math.min(parsedEnd, duration));
  if (end <= start) {
    return { mode, duration, ranges: [], valid: false, message: "Waktu End harus lebih besar dari Start dan berada dalam durasi video." };
  }
  return { mode, duration, ranges: [[start, end]], valid: true, selectedDuration: end - start };
}

function momentInsideAnalysisRanges(moment, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return true;
  const start = Number(moment?.start || 0);
  const end = Number(moment?.end || start);
  return ranges.some(([rangeStart, rangeEnd]) => (
    start >= Number(rangeStart) - 0.05 && end <= Number(rangeEnd) + 0.05
  ));
}

function updateTimelinePreview(options = {}) {
  const normalizeInputs = options.normalizeInputs !== false;
  const mode = fieldValue("selectionMode", "full");
  const badge = $("#timelineRangeBadge");
  const multipleField = $("#multipleRangesField");
  if (multipleField) multipleField.style.display = mode === "multiple" ? "grid" : "none";
  const duration = analysisDuration();
  const maxValue = Math.max(1, Math.round(duration * 10));
  const startRange = $("#analysisStartRange");
  const endRange = $("#analysisEndRange");
  const startInput = $("#rangeStart");
  const endInput = $("#rangeEnd");
  if (startRange) startRange.max = String(maxValue);
  if (endRange) endRange.max = String(maxValue);
  if (startRange) startRange.disabled = !duration || mode !== "range";
  if (endRange) endRange.disabled = !duration || mode !== "range";
  if (startInput) startInput.readOnly = !duration || mode !== "range";
  if (endInput) endInput.readOnly = !duration || mode !== "range";

  let start = parseTimeInput(fieldValue("rangeStart", "0"), 0);
  let end = parseTimeInput(fieldValue("rangeEnd", ""), duration);
  if (!duration) {
    start = 0;
    end = 0;
  }
  if (mode === "full") {
    start = 0;
    end = duration;
    if (normalizeInputs) {
      setValue("#rangeStart", formatDuration(start));
      setValue("#rangeEnd", duration ? formatDuration(end) : "");
    }
  } else if (mode === "range" && duration) {
    start = Math.max(0, Math.min(start, Math.max(0, duration - 1)));
    end = Math.max(start + 1, Math.min(end || duration, duration));
    if (normalizeInputs) {
      setValue("#rangeStart", formatDuration(start));
      setValue("#rangeEnd", formatDuration(end));
    }
  }
  if (startRange) startRange.value = String(Math.round(start * 10));
  if (endRange) endRange.value = String(Math.round(end * 10));
  setText("#analysisStartBadge", formatDuration(start));
  setText("#analysisEndBadge", duration ? formatDuration(end) : "Menunggu metadata");

  if (!badge) return;
  if (mode === "range") {
    badge.textContent = duration ? `${formatDuration(start)} - ${formatDuration(end)}` : "Range belum siap";
  } else if (mode === "multiple") {
    const parsed = parseMultipleAnalysisRangeInput(fieldValue("multipleRanges", ""), duration);
    const ranges = parsed.ranges;
    const selectedDuration = ranges.reduce((total, [rangeStart, rangeEnd]) => total + (rangeEnd - rangeStart), 0);
    badge.textContent = parsed.invalidEntries.length
      ? `${parsed.invalidEntries.length} range tidak valid`
      : `${ranges.length} range${selectedDuration ? ` · ${formatDuration(selectedDuration)}` : ""}`;
  } else {
    badge.textContent = duration ? `Full video · ${formatDuration(duration)}` : "Full video · menunggu metadata";
  }
}

function updateAnalysisRangeFromSeekbar(changedEdge = "end") {
  const duration = analysisDuration();
  const startRange = $("#analysisStartRange");
  const endRange = $("#analysisEndRange");
  if (!startRange || !endRange || !duration) return;
  const maxSeconds = duration;
  let start = Math.max(0, Math.min(Number(startRange.value || 0) / 10, maxSeconds));
  let end = Math.max(0, Math.min(Number(endRange.value || 0) / 10, maxSeconds));
  if (end - start < 1) {
    if (changedEdge === "start") start = Math.max(0, end - 1);
    else end = Math.min(maxSeconds, start + 1);
  }
  setValue("#selectionMode", "range");
  setValue("#rangeStart", formatDuration(start));
  setValue("#rangeEnd", formatDuration(end));
  updateTimelinePreview();
}

function adjustAnalysisRange(seconds) {
  const duration = analysisDuration();
  if (!duration) {
    toast("Masukkan video agar rentang waktu dapat diatur");
    return;
  }
  const adjustment = Number(seconds || 0);
  let start = parseTimeInput(fieldValue("rangeStart", "0"), 0);
  let end = parseTimeInput(fieldValue("rangeEnd", ""), duration);
  if (adjustment < 0) start = Math.max(0, Math.min(end - 1, start + adjustment));
  if (adjustment > 0) end = Math.min(duration, Math.max(start + 1, end + adjustment));
  setValue("#selectionMode", "range");
  setValue("#rangeStart", formatDuration(start));
  setValue("#rangeEnd", formatDuration(end));
  updateTimelinePreview();
}

const OVERLAY_DESIGN_WIDTH = 1080;

function selectedOutputDimensions() {
  const resolution = String(fieldValue("resolutionProfile", "1080p") || "1080p").toLowerCase();
  const format = String(fieldValue("formatProfile", "9:16 YouTube Shorts") || "9:16").toLowerCase();
  const width = ({ "720p": 720, "1080p": 1080, "2k": 1440, "4k": 2160 })[resolution] || 1080;
  if (format.includes("1:1")) return { width, height: width };
  if (format.includes("16:9")) return { width: Math.round(width * 16 / 9), height: width };
  return { width, height: Math.round(width * 16 / 9) };
}

function syncPreviewFrameGeometry(frame) {
  if (!frame) return;
  const { width, height } = selectedOutputDimensions();
  const ratio = width / height;
  frame.style.aspectRatio = `${width} / ${height}`;
  frame.style.maxWidth = ratio > 1.2 ? "520px" : ratio > 0.8 ? "440px" : "340px";
  frame.dataset.outputWidth = String(width);
  frame.dataset.outputHeight = String(height);
}

function previewPixelScale(frame) {
  const { width } = selectedOutputDimensions();
  const previewWidth = frame?.clientWidth || (width > 1080 ? 340 : Math.min(340, width));
  return previewWidth / width;
}

function previewPixelsFromDesign(value, frame) {
  const { width } = selectedOutputDimensions();
  const renderPixels = Number(value || 0) * width / OVERLAY_DESIGN_WIDTH;
  return renderPixels * previewPixelScale(frame);
}

function updateRangeReadout(id, value, suffix) {
  const output = $(`#${id}Value`);
  if (output) output.value = `${Math.round(Number(value || 0))}${suffix}`;
}

function setBrandPreset(preset) {
  const positions = {
    "top-left": [14, 12, 18, 20, "Top left"],
    "top-center": [50, 12, 50, 20, "Top center"],
    "top-right": [86, 12, 82, 20, "Top right"],
    "middle-left": [16, 50, 18, 58, "Middle left"],
    "center": [50, 42, 50, 52, "Center"],
    "middle-right": [84, 50, 78, 58, "Middle right"],
    "bottom-left": [14, 88, 18, 80, "Bottom left"],
    "bottom-center": [50, 88, 50, 80, "Bottom center"],
    "bottom-right": [86, 88, 82, 80, "Bottom right"]
  };
  const next = positions[preset] || positions["top-right"];
  setValue("#logoX", next[0]);
  setValue("#logoY", next[1]);
  setValue("#watermarkTextX", next[2]);
  setValue("#watermarkTextY", next[3]);
  setValue("#watermarkPosition", next[4]);
  updateBrandPreview();
}

function updateBrandPreview() {
  const frame = $("#brandPreviewFrame");
  const logo = $("#brandPreviewLogo");
  const text = $("#brandPreviewText");
  syncPreviewFrameGeometry(frame);
  const logoPath = fieldValue("logoAssetPath", "");
  if (logo) {
    logo.src = toFilePreviewSrc(logoPath || "assets/icon-512.png");
    logo.style.left = `${percentField("logoX", 84)}%`;
    logo.style.top = `${percentField("logoY", 12)}%`;
    logo.style.width = `${Math.max(8, Math.min(60, numberField("logoScale", 18)))}%`;
    logo.style.opacity = `${Math.max(0.1, Math.min(1, numberField("logoOpacity", 90) / 100))}`;
    logo.style.transform = `translate(-50%, -50%) rotate(${numberField("logoRotation", 0)}deg)`;
  }
  if (text) {
    const value = fieldValue("watermarkText", "@cliperai") || "@cliperai";
    text.textContent = value;
    refreshWatermarkFontFace();
    text.style.left = `${percentField("watermarkTextX", 82)}%`;
    text.style.top = `${percentField("watermarkTextY", 20)}%`;
    text.style.fontFamily = `"${fieldValue("watermarkFontFamily", "Arial Black")}", Arial, sans-serif`;
    const textSize = Math.max(20, Math.min(96, numberField("watermarkTextSize", 42)));
    text.style.fontSize = `${previewPixelsFromDesign(textSize, frame)}px`;
    text.style.color = fieldValue("watermarkTextColor", "#ffffff");
    text.style.opacity = `${Math.max(0.1, Math.min(1, numberField("watermarkOpacity", 68) / 100))}`;
    const shadow = previewPixelsFromDesign(numberField("watermarkTextShadow", 2), frame);
    const outline = previewPixelsFromDesign(2, frame);
    text.style.webkitTextStroke = `${outline}px ${fieldValue("watermarkTextStroke", "#000000")}`;
    text.style.textShadow = shadow ? `${shadow}px ${shadow}px ${shadow * 1.5}px rgba(0,0,0,.55)` : "none";
  }
  updateRangeReadout("logoScale", numberField("logoScale", 18), "%");
  updateRangeReadout("logoOpacity", numberField("logoOpacity", 90), "%");
  updateRangeReadout("logoRotation", numberField("logoRotation", 0), "°");
  updateRangeReadout("watermarkTextSize", numberField("watermarkTextSize", 42), " px");
  updateRangeReadout("watermarkOpacity", numberField("watermarkOpacity", 68), "%");
}

function refreshWatermarkFontFace() {
  const fontPath = fieldValue("watermarkFontPath", "");
  const fontFamily = fieldValue("watermarkFontFamily", "Arial Black");
  let style = $("#watermarkCustomFontStyle");
  if (!fontPath || !fontFamily) {
    if (style) style.textContent = "";
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "watermarkCustomFontStyle";
    document.head.appendChild(style);
  }
  style.textContent = `@font-face{font-family:"${fontFamily.replace(/"/g, "")}";src:url("${toFilePreviewSrc(fontPath)}");}`;
}

function markSubtitlePreset(preset = "") {
  setValue("#subtitlePreset", preset);
  $$("[data-subtitle-preset]").forEach((button) => {
    const active = button.dataset.subtitlePreset === preset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function applySubtitlePreset(preset) {
  const presets = {
    opus: {
      captionStyle: "Karaoke bold",
      fontFamily: "Arial Black",
      fontSize: 86,
      primaryColor: "#ffffff",
      activeColor: "#19ff47",
      strokeColor: "#000000",
      shadow: 3,
      animation: "Pop",
      letterSpacing: 1.4,
      wordHighlight: true
    },
    capcut: {
      captionStyle: "TikTok style",
      fontFamily: "Arial Black",
      fontSize: 84,
      primaryColor: "#ffffff",
      activeColor: "#ffe600",
      strokeColor: "#000000",
      shadow: 3,
      animation: "Scale",
      letterSpacing: 1.1,
      wordHighlight: true
    },
    tiktok: {
      captionStyle: "TikTok style",
      fontFamily: "Arial Black",
      fontSize: 92,
      primaryColor: "#ffffff",
      activeColor: "#19ff47",
      strokeColor: "#000000",
      shadow: 4,
      animation: "Bounce",
      letterSpacing: 0.8,
      wordHighlight: true
    },
    news: {
      captionStyle: "Clean subtitle",
      fontFamily: "Arial",
      fontSize: 64,
      primaryColor: "#ffffff",
      activeColor: "#ffe600",
      strokeColor: "#10202a",
      shadow: 1,
      animation: "Fade",
      letterSpacing: 0.3,
      wordHighlight: false
    },
    podcast: {
      captionStyle: "YouTube Shorts style",
      fontFamily: "Arial Black",
      fontSize: 76,
      primaryColor: "#ffffff",
      activeColor: "#19ff47",
      strokeColor: "#000000",
      shadow: 2,
      animation: "Scale",
      letterSpacing: 1.2,
      wordHighlight: true
    },
    gaming: {
      captionStyle: "Karaoke bold",
      fontFamily: "Arial Black",
      fontSize: 94,
      primaryColor: "#ffffff",
      activeColor: "#ffe600",
      strokeColor: "#000000",
      shadow: 4,
      animation: "Bounce",
      letterSpacing: 0.6,
      wordHighlight: true
    }
  };
  const next = presets[preset] || presets.opus;
  setValue("#captionStyle", next.captionStyle);
  setValue("#subtitleFontFamily", next.fontFamily);
  setValue("#subtitleFontSize", next.fontSize);
  setValue("#subtitlePrimaryColor", next.primaryColor);
  setValue("#subtitleActiveColor", next.activeColor);
  setValue("#subtitleStrokeColor", next.strokeColor);
  setValue("#subtitleShadow", next.shadow);
  setValue("#subtitleAnimation", next.animation);
  setValue("#subtitleLetterSpacing", next.letterSpacing);
  setValue("#subtitleWordHighlightToggle", next.wordHighlight);
  markSubtitlePreset(preset);
  updateSubtitlePreview();
}

function applyOutputQualityPreset(profile = fieldValue("outputQualityProfile", "balanced"), options = {}) {
  const preset = getOutputQualityPreset(profile);
  setValue("#outputQualityProfile", profile);
  setValue("#formatProfile", preset.formatProfile);
  setValue("#resolutionProfile", preset.resolutionProfile);
  setValue("#fpsProfile", preset.fpsProfile);
  setValue("#crfProfile", preset.crfProfile);

  if (profile === "capcut_opus_2k") {
    applySubtitlePreset("capcut");
    setValue("#subtitleBurnToggle", true);
    setValue("#hookOpeningToggle", true);
    setValue("#audioEnhanceToggle", true);
    setValue("#subtitleFontSize", "90");
    setValue("#subtitleActiveColor", "#19ff47");
    setValue("#subtitleShadow", "4");
    updateSubtitlePreview();
  }

  renderPipelinePreview();
  if (!options.silent) {
    toast(profile === "capcut_opus_2k" ? "Preset referensi 2K 60fps diterapkan" : "Quality preset diterapkan");
  }
}

function refreshSubtitleFontFace() {
  const fontPath = fieldValue("subtitleFontPath", "");
  const fontFamily = fieldValue("subtitleFontFamily", "Arial Black");
  let style = $("#subtitleCustomFontStyle");
  if (!fontPath || !fontFamily) {
    if (style) style.textContent = "";
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "subtitleCustomFontStyle";
    document.head.appendChild(style);
  }
  style.textContent = `@font-face{font-family:"${fontFamily.replace(/"/g, "")}";src:url("${toFilePreviewSrc(fontPath)}");}`;
}

function updateSubtitlePreview() {
  const frame = $("#subtitlePreviewFrame");
  const preview = $("#subtitlePreviewText");
  if (!preview) return;
  syncPreviewFrameGeometry(frame);
  if (state.subtitlePreviewTimer) {
    clearInterval(state.subtitlePreviewTimer);
    state.subtitlePreviewTimer = null;
  }
  refreshSubtitleFontFace();
  const words = (fieldValue("subtitlePreviewInput", "TAPI GUE HERAN") || "TAPI GUE HERAN").trim().split(/\s+/);
  const animation = String(fieldValue("subtitleAnimation", "Scale") || "Scale").toLowerCase();
  const wordHighlight = Boolean(fieldValue("subtitleWordHighlightToggle", true));
  let activeIndex = words.length > 1 ? 1 : 0;
  const renderFrame = () => {
    const visibleWords = animation === "typewriter" ? words.slice(0, activeIndex + 1) : words;
    const renderedWords = visibleWords.map((word, index) => {
      const safeWord = escapeHtml(word);
      return wordHighlight && index === activeIndex ? `<span>${safeWord}</span>` : safeWord;
    }).join(" ");
    preview.innerHTML = wordHighlight ? renderedWords : `<span class="subtitle-line-effect">${renderedWords}</span>`;
  };
  preview.className = `subtitle-preview-text animation-${animation}`;
  renderFrame();
  preview.style.fontFamily = `"${fieldValue("subtitleFontFamily", "Arial Black")}", Arial, sans-serif`;
  const fontSize = Math.max(40, Math.min(128, numberField("subtitleFontSize", 84)));
  preview.style.left = `${percentField("subtitleX", 50)}%`;
  preview.style.top = `${percentField("subtitleY", 82)}%`;
  preview.style.fontSize = `${previewPixelsFromDesign(fontSize, frame)}px`;
  preview.style.letterSpacing = `${previewPixelsFromDesign(Math.max(0, Math.min(3, numberField("subtitleLetterSpacing", 1.1))), frame)}px`;
  preview.style.color = fieldValue("subtitlePrimaryColor", "#ffffff");
  preview.style.setProperty("--subtitle-active-color", fieldValue("subtitleActiveColor", "#ffe600"));
  const shadow = previewPixelsFromDesign(numberField("subtitleShadow", 3), frame);
  const outline = previewPixelsFromDesign(5, frame);
  preview.style.webkitTextStroke = `${outline}px ${fieldValue("subtitleStrokeColor", "#000000")}`;
  preview.style.textShadow = shadow ? `${shadow}px ${shadow}px ${shadow * 1.5}px rgba(0,0,0,.72)` : "none";
  updateRangeReadout("subtitleFontSize", fontSize, " px");
  if (words.length > 1 && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    state.subtitlePreviewTimer = setInterval(() => {
      activeIndex = (activeIndex + 1) % words.length;
      renderFrame();
    }, animation === "bounce" ? 760 : 680);
  }
}

function bindPreviewDrag(element, xId, yId, options = {}) {
  if (!element) return;
  element.addEventListener("pointerdown", (event) => {
    const frame = $(options.frameSelector || "#brandPreviewFrame");
    if (!frame) return;
    event.preventDefault();
    element.classList.add("is-pointer-dragging");
    element.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const rect = frame.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const halfWidth = Math.min(49, elementRect.width / rect.width * 50);
      const halfHeight = Math.min(49, elementRect.height / rect.height * 50);
      const x = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      const y = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      const nextX = Math.max(halfWidth, Math.min(100 - halfWidth, x));
      const nextY = Math.max(halfHeight, Math.min(100 - halfHeight, y));
      setValue(`#${xId}`, Math.round(nextX * 10) / 10);
      setValue(`#${yId}`, Math.round(nextY * 10) / 10);
      (options.update || updateBrandPreview)();
    };
    const stop = () => {
      element.classList.remove("is-pointer-dragging");
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
      saveConfig({ silent: true });
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "-";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

function daysSince(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function cookieAgeText(value) {
  const days = daysSince(value);
  if (days === null) return "-";
  if (days === 0) return "Hari ini";
  return `${days} hari`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  if (hours > 0) {
    const mins = Math.floor((value % 3600) / 60);
    return `${hours}:${String(mins).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function activeEnhancements() {
  const settingsWatermark = Boolean(fieldValue("watermarkEnabled", false) && fieldValue("watermarkInOutput", false));
  const preset = getProductionRenderPreset();
  return [
    ["smartCrop", "Smart crop", preset.smartCrop],
    ["dynamicZoom", "Dynamic zoom", preset.dynamicZoom],
    ["faceTrack", "Face tracking", preset.faceTrack],
    ["addCaptions", "ASS caption", preset.addCaptions && preset.burnSubtitle],
    ["autoCut", "Auto cut", preset.autoCut],
    ["addHook", "Hook intro", preset.addHook],
    ["addWatermark", "Watermark", settingsWatermark]
  ].map(([id, label, enabled]) => ({ id, label, enabled: Boolean(enabled) }));
}

function estimateRenderSeconds() {
  const clips = Math.max(1, selectedMoments().length || Number($("#clipCount")?.value || 1));
  const avgDuration = selectedMoments().length
    ? selectedMoments().reduce((total, item) => total + Number(item.durationSeconds || 35), 0) / selectedMoments().length
    : 40;
  let multiplier = 1.2;
  const preset = getProductionRenderPreset();
  if (preset.faceTrack) multiplier += 0.65;
  if (preset.dynamicZoom) multiplier += 0.2;
  if (preset.addCaptions) multiplier += 0.35;
  if (preset.addHook) multiplier += 0.1;
  return Math.ceil(clips * avgDuration * multiplier);
}

function renderPipelinePreview() {
  const summary = $("#pipelineSummary");
  if (!summary) {
    setText("#pipelineEstimate", `Waktu proses: ${formatDuration(estimateRenderSeconds())}`);
    return;
  }
  const items = activeEnhancements();
  const used = items.filter((item) => item.enabled);
  const skipped = items.filter((item) => !item.enabled);
  const output = [
    $("#formatProfile")?.value || "9:16 YouTube Shorts",
    $("#resolutionProfile")?.value || "1080p",
    $("#gpuToggle")?.checked ? "GPU auto" : "CPU"
  ].join(" · ");
  summary.innerHTML = `
    <div><span>Used</span><strong>${used.length ? used.map((item) => item.label).join(", ") : "-"}</strong></div>
    <div><span>Skipped</span><strong>${skipped.length ? skipped.map((item) => item.label).join(", ") : "-"}</strong></div>
    <div><span>Output</span><strong>${output}</strong></div>
  `;
  setText("#pipelineEstimate", `Waktu proses: ${formatDuration(estimateRenderSeconds())}`);
}

function updateRenderStats(event = {}) {
  if (!state.renderStartedAt) state.renderStartedAt = Date.now();
  const elapsed = (Date.now() - state.renderStartedAt) / 1000;
  const percent = Number(event.progress || state.progress || 0);
  const eta = percent > 2 ? elapsed * (100 - percent) / percent : null;
  setText("#renderClipStat", event.clipIndex && event.totalClips ? `${event.clipIndex}/${event.totalClips}` : "-");
  setText("#renderStageStat", event.stage || event.message || "Processing");
  setText("#renderElapsedStat", formatDuration(elapsed));
  setText("#renderEtaStat", eta === null ? "-" : formatDuration(eta));
  setText("#renderFpsStat", event.fps ? String(event.fps) : "-");
  setText("#renderSpeedStat", event.speed ? String(event.speed) : "-");
}

function selectedClipCountLabel() {
  const count = selectedMoments().length;
  return `${count} clip${count === 1 ? "" : "s"}`;
}

function updateProcessButtons() {
  const count = selectedMoments().length;
  setText("#processSelected", count ? `Render ${count} clip` : "Render pilihan");
}

function openProcessDialog() {
  const clips = selectedMoments();
  if (!clips.length) {
    toast("Pilih minimal 1 highlight");
    return;
  }
  updateProcessButtons();
  startProcessing();
}

function normalizeCookiesInfo(config = {}) {
  const path = config.cookies_path || config.cookiesPath || config.cookies?.path || "";
  if (!path) return null;
  const meta = config.cookies_meta || config.cookies || {};
  return {
    path,
    present: meta.present !== false,
    state: meta.state || "SESSION_PRESENT",
    health: meta.health || "PRESENT",
    source: meta.source || "manual_import",
    browser: meta.browser || "unknown",
    autoRefresh: meta.autoRefresh === true,
    fileName: meta.fileName || path.split(/[\\/]/).pop() || "cookies.txt",
    sizeBytes: meta.sizeBytes || meta.size || 0,
    importedAt: config.cookies_last_import || meta.updatedAt || meta.importedAt || meta.importDate || "",
    lastUsed: config.cookies_last_used || meta.lastUsed || "",
    lastTest: config.cookies_last_test || meta.lastChecked || meta.lastTest || "",
    lastSuccess: meta.lastSuccess || "",
    lastFailure: meta.lastFailure || "",
    errorClass: meta.errorClass || "",
    reason: meta.reason || "",
    status: config.cookies_status || meta.status || "Cookies Loaded",
    testStatus: meta.testStatus || config.cookies_test_status || "Belum dites",
    testUrl: meta.testUrl || config.cookies_test_url || "",
    validation: meta.validation || null
  };
}

function renderCookiesManager() {
  const info = state.cookiesInfo;
  const hasCookies = Boolean(state.cookiesPath && info);
  const importedAt = info?.importedAt;
  const sessionState = String(info?.state || "NO_SESSION");
  const needsUpdate = ["SESSION_INVALID", "SESSION_UPDATE_REQUIRED"].includes(sessionState);
  const hasError = sessionState === "SESSION_ERROR";
  const statusTitle = !hasCookies
    ? "YouTube Session belum tersedia"
    : needsUpdate
      ? "YouTube Session perlu diperbarui"
      : sessionState === "SESSION_VALID"
        ? "YouTube Session aktif"
        : "YouTube Session tersimpan";
  const statusBadge = !hasCookies
    ? "Belum tersedia"
    : needsUpdate
      ? "Update required"
      : hasError
        ? "Periksa session"
        : sessionState === "SESSION_VALID" ? "Valid" : "Tersimpan";

  setText("#cookiesStatusTitle", statusTitle);
  setText("#cookiesStatusBadge", statusBadge);
  setText("#cookiesFileName", hasCookies ? info.fileName : "-");
  setText("#cookiesFileSize", hasCookies ? formatBytes(info.sizeBytes) : "-");
  setText("#cookiesImportDate", hasCookies ? formatDate(importedAt) : "-");
  setText("#cookiesLastUsed", hasCookies ? formatDate(info.lastUsed) : "-");
  setText("#cookiesAge", hasCookies ? cookieAgeText(importedAt) : "-");
  setText("#cookiesTestStatus", hasCookies ? (info.reason || info.testStatus || info.status || "Belum diperiksa") : "Belum diperiksa");
  setText("#cookiesTestUrl", hasCookies ? `${info.source || "manual_import"} · ${info.browser || "browser tidak diketahui"}` : "-");
  setText("#cookieState", hasCookies ? "Session tersimpan aman di perangkat" : "Belum dipilih");
  setText("#cookiesAgeBadge", statusTitle);

  const badge = $("#cookiesAgeBadge");
  if (badge) {
    badge.classList.toggle("warning", needsUpdate || hasError);
    badge.classList.toggle("ok", hasCookies && !needsUpdate && !hasError);
  }
  const status = $("#cookiesStatusBadge");
  if (status) {
    status.classList.toggle("warning", needsUpdate || hasError);
    status.classList.toggle("ok", hasCookies && !needsUpdate && !hasError);
  }
  if (hasCookies && info.browser && info.browser !== "unknown") {
    setValue("#youtubeSessionBrowser", info.browser);
  }
}

function heatmapRuntimeCapability() {
  const heatmap = state.lastAnalysis?.video?.heatmap;
  if (!heatmap) {
    return { value: "Bukti tambahan bila tersedia", state: "optional" };
  }
  const markerCount = Math.max(0, Number(heatmap.markerCount || 0));
  const peakCount = Math.max(0, Number(heatmap.peakCount || 0));
  const status = String(heatmap.status || "unavailable");
  if (status === "available") {
    return {
      value: `${markerCount} marker · ${peakCount} peak relevan`,
      state: "ready"
    };
  }
  if (status === "available_outside_selection") {
    return { value: "Tersedia, tidak ada peak di area pilihan", state: "optional" };
  }
  if (status === "available_no_distinct_peak") {
    return { value: "Tersedia, belum ada peak yang cukup berbeda", state: "optional" };
  }
  if (status === "not_youtube") {
    return { value: "Hanya tersedia untuk video YouTube publik", state: "optional" };
  }
  if (status === "network_unavailable") {
    return { value: "Jaringan YouTube belum tersedia saat analisis", state: "fallback" };
  }
  if (status === "not_public") {
    return { value: "Most Replayed publik tidak tersedia", state: "optional" };
  }
  return { value: "Belum tersedia untuk analisis ini", state: "optional" };
}

const GPU_ENCODER_LABELS = {
  h264_nvenc: "NVIDIA NVENC",
  h264_amf: "AMD AMF",
  h264_qsv: "Intel Quick Sync"
};

function detectedHardwareStatus(deps = state.dependencies, useGpu = Boolean($("#gpuToggle")?.checked)) {
  const available = Array.isArray(deps?.encoders?.available) ? deps.encoders.available : [];
  const hardware = ["h264_nvenc", "h264_amf", "h264_qsv"].filter((encoder) => available.includes(encoder));
  const labels = hardware.map((encoder) => GPU_ENCODER_LABELS[encoder]);
  const cpuReady = available.includes("libx264");

  if (!deps?.ffmpeg?.ok) {
    return {
      detected: "FFmpeg belum siap",
      active: "Menunggu FFmpeg untuk mendeteksi encoder"
    };
  }
  if (!useGpu) {
    return {
      detected: labels.length ? `${labels.join(", ")} tersedia` : "Encoder GPU tidak tersedia lewat FFmpeg",
      active: cpuReady ? "CPU dipilih - libx264" : "Encoder CPU belum tersedia"
    };
  }
  if (hardware.length) {
    const primary = hardware[0];
    const fallback = [...hardware.slice(1), ...(cpuReady ? ["libx264"] : [])]
      .map((encoder) => GPU_ENCODER_LABELS[encoder] || encoder)
      .join(" -> ");
    return {
      detected: `${labels.join(", ")} terdeteksi oleh FFmpeg`,
      active: `${GPU_ENCODER_LABELS[primary]} dipilih${fallback ? `; cadangan ${fallback}` : ""}`
    };
  }
  return {
    detected: "Tidak ada encoder GPU yang tersedia lewat FFmpeg",
    active: cpuReady ? "CPU fallback - libx264" : "Encoder belum tersedia"
  };
}

function refreshHardwareStatus(deps = state.dependencies) {
  const hardware = detectedHardwareStatus(deps);
  setText("#detectedGpu", hardware.detected);
  setText("#activeEncoder", hardware.active);
  return hardware;
}

function runtimeCapabilityRegistry(deps = state.dependencies) {
  const checked = Boolean(deps);
  const valueOrPending = (value, ok) => (ok ? value : checked ? "Perlu disiapkan" : "Belum diperiksa");
  const hardwareEncoders = Array.isArray(deps?.encoders?.available)
    ? deps.encoders.available.filter((encoder) => encoder !== "libx264")
    : [];
  const hardwareStatus = detectedHardwareStatus(deps);
  const hasCpuEncoder = deps?.encoders?.available?.includes("libx264");
  const heatmap = heatmapRuntimeCapability();

  return [
    {
      group: "Komponen inti",
      items: [
        { name: "Python worker", value: valueOrPending(deps?.python?.version || "Siap", deps?.python?.ok), state: deps?.python?.ok ? "ready" : "needs-setup" },
        { name: "Unduh video", value: valueOrPending(deps?.yt_dlp?.version || "Siap", deps?.yt_dlp?.ok), state: deps?.yt_dlp?.ok ? "ready" : "needs-setup" },
        { name: "FFmpeg render", value: valueOrPending("Siap", deps?.ffmpeg?.ok), state: deps?.ffmpeg?.ok ? "ready" : "needs-setup" },
        { name: "Pemeriksa media", value: valueOrPending("Siap", deps?.ffprobe?.ok), state: deps?.ffprobe?.ok ? "ready" : "needs-setup" }
      ]
    },
    {
      group: "Analisis video",
      items: [
        { name: "Deteksi adegan", value: "Terpasang di Cliper", state: "available" },
        { name: "Pelacakan wajah", value: deps?.opencv?.ok ? `OpenCV ${deps.opencv.version || "siap"}` : "Fallback crop aktif", state: deps?.opencv?.ok ? "ready" : "fallback" },
        { name: "Pelacakan orang", value: deps?.mediapipe?.ok ? `MediaPipe ${deps.mediapipe.version || "siap"}` : "Opsional", state: deps?.mediapipe?.ok ? "ready" : "optional" },
        { name: "Pembicara aktif", value: "Dipilih dari bukti audio dan visual", state: "available" },
        { name: "YouTube heatmap", ...heatmap }
      ]
    },
    {
      group: "Cerita dan subtitle",
      items: [
        { name: "Transkripsi lokal", value: deps?.faster_whisper?.ok ? `Faster-Whisper ${deps.faster_whisper.version || "siap"}` : "Gunakan subtitle sumber bila tersedia", state: deps?.faster_whisper?.ok ? "ready" : "optional" },
        { name: "Penyusun cerita", value: "Terpasang di Cliper", state: "available" },
        { name: "Subtitle clip-local", value: deps?.ffmpeg?.ok ? "Siap dibakar ke video" : valueOrPending("Menunggu FFmpeg", false), state: deps?.ffmpeg?.ok ? "ready" : "needs-setup" },
        { name: "Cliper AI Cloud", value: state.cloudConnectionOk ? (state.cloudRouterReady ? "Terhubung" : "Terhubung, provider sedang disiapkan") : "Hubungkan API key untuk bantuan AI", state: state.cloudConnectionOk ? "ready" : "optional" }
      ]
    },
    {
      group: "Output",
      items: [
        { name: "Encoder perangkat", value: hardwareEncoders.length ? hardwareStatus.detected : hasCpuEncoder ? "CPU stabil - libx264" : valueOrPending("Menunggu FFmpeg", false), state: hardwareEncoders.length ? "ready" : hasCpuEncoder ? "fallback" : "needs-setup" },
        { name: "Watermark dan hook", value: "Siap saat diaktifkan di pengaturan", state: "available" },
        { name: "Validasi MP4", value: deps?.ffprobe?.ok ? "Video dan audio diperiksa setelah render" : valueOrPending("Menunggu FFprobe", false), state: deps?.ffprobe?.ok ? "ready" : "needs-setup" }
      ]
    }
  ];
}

function renderRuntimeList(deps = state.dependencies) {
  const list = $("#runtimeList");
  if (!list) return;
  list.innerHTML = runtimeCapabilityRegistry(deps)
    .map(({ group, items }) => `
      <section class="runtime-group">
        <h3>${group}</h3>
        ${items.map(({ name, value, state }) => `
          <div class="runtime-item runtime-${state}">
            <span>${name}</span>
            <strong>${value}</strong>
          </div>
        `).join("")}
      </section>
    `)
    .join("");
}

function isValidYoutubeUrl(url) {
  return /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.test(String(url).trim());
}

function isAiEnabled() {
  const payload = providerPayload();
  return Boolean(payload.apiKey && payload.baseUrl && payload.model);
}

let metadataTimer = null;
let metadataUrl = "";
let metadataPendingUrl = "";

function populateSubtitleLanguages(video = {}) {
  const select = $("#subtitleLang");
  if (!select) return;
  const options = Array.isArray(video.subtitle_language_options) ? video.subtitle_language_options : [];
  if (!options.length) {
    select.innerHTML = `
      <option value="">No YouTube subtitle found</option>
      <option value="local">Use local transcription if available</option>
    `;
    return;
  }
  select.innerHTML = options
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join("");
  if (video.subtitle_language) {
    select.value = video.subtitle_language;
  }
}

async function fetchMetadata(url) {
  if (!window.cliper) {
    setText("#previewTitle", "Buka .exe untuk metadata nyata");
    setText("#previewUrl", url || "Masukkan link YouTube");
    return false;
  }
  if (!isValidYoutubeUrl(url)) {
    setText("#previewTitle", "URL tidak valid");
    setText("#previewUrl", url || "Masukkan link YouTube");
    return false;
  }
  metadataPendingUrl = url;
  pushLog(`[metadata] fetching metadata for ${url}`);
  setText("#previewTitle", "Memuat metadata...");
  setText("#previewUrl", url);
  setText("#subtitleMetric", "Loading subtitles...");
  const subtitleSelect = $("#subtitleLang");
  if (subtitleSelect) {
    subtitleSelect.innerHTML = `<option value="">Loading subtitles...</option>`;
  }
  try {
    const payload = {
      ...collectPayload(),
      useMomentAI: isAiEnabled(),
      metadataOnly: true,
      clipCount: 0,
      minDuration: 30,
      targetDuration: 75,
      maxDuration: 180
    };
    const result = await window.cliper.analyze(payload);
    if ($("#youtubeUrl").value.trim() !== url) return false;
    if (result.type === "error") {
      setText("#previewTitle", "Metadata gagal");
      setText("#subtitleMetric", "Metadata error");
      pushLog(`[metadata] gagal: ${result.message}`);
      return false;
    }
    const data = result.result;
    state.videoDuration = Number(data.video?.duration || 0);
    if (!Number.isFinite(state.videoDuration) || state.videoDuration <= 0) {
      state.videoDuration = 0;
      setText("#previewTitle", "Durasi metadata tidak tersedia");
      setText("#previewDuration", "Durasi tidak tersedia");
      pushLog("[metadata] duration kosong atau tidak valid");
      updateTimelinePreview();
      return false;
    }
    metadataUrl = url;
    setText("#previewTitle", data.video?.title || "Tidak ada judul");
    setText("#previewUrl", data.video?.webpage_url || url);
    setText("#subtitleMetric", data.video?.subtitle_language || "No subtitle");
    populateSubtitleLanguages(data.video || {});
    state.previewImageUrl = data.video?.thumbnail || "";
    drawPreview();
    state.lastAnalysis = null;
    state.lastTranscript = [];
    state.activeMomentId = null;
    updateTimelinePreview();
    updateCounters();
    pushLog(`[metadata] berhasil dimuat: ${data.video?.title || url} · duration=${formatDuration(state.videoDuration)} (${state.videoDuration}s)`);
    return true;
  } catch (error) {
    setText("#previewTitle", "Metadata gagal");
    setText("#subtitleMetric", "Metadata error");
    pushLog(`[metadata] error: ${error?.message || error}`);
    return false;
  } finally {
    if (metadataPendingUrl === url) metadataPendingUrl = "";
  }
}

function scheduleMetadataFetch(force = false) {
  const url = $("#youtubeUrl").value.trim();
  if (!url || (!force && (url === metadataUrl || url === metadataPendingUrl))) {
    return;
  }
  clearTimeout(metadataTimer);
  metadataTimer = setTimeout(() => fetchMetadata(url), 700);
}

function resetSourceMetadata(nextUrl = "") {
  if (nextUrl && nextUrl === metadataUrl) return;
  state.videoDuration = 0;
  state.lastAnalysis = null;
  state.lastTranscript = [];
  state.activeMomentId = null;
  state.previewImageUrl = "";
  metadataUrl = "";
  setValue("#selectionMode", "full");
  setValue("#rangeStart", "00:00");
  setValue("#rangeEnd", "");
  setValue("#multipleRanges", "");
  setText("#previewScore", "-");
  updateTimelinePreview();
  updateCounters();
}

async function markCookiesUsed() {
  if (!state.cookiesInfo) return;
  state.cookiesInfo.lastUsed = new Date().toISOString();
  renderCookiesManager();
  await saveConfig({ silent: true });
}

function renderSessions() {
  if (sessions.length === 0) {
    $("#sessionList").innerHTML = `
      <div class="empty-state wide">
        <strong>Belum ada output MP4.</strong>
        <span>Hasil render yang tampil di sini hanya file MP4 final. File internal tidak ditampilkan sebagai output utama.</span>
      </div>
    `;
    return;
  }
  $("#sessionList").innerHTML = sessions
    .map(
      (session, index) => `
        <article class="session-card">
          <div class="session-thumb">
            <span>${session.clips}</span>
          </div>
          <div>
            <h3>${session.name}</h3>
            <p>${session.clips} MP4 - ${session.date} - ${session.size}</p>
            ${session.publishingPlan ? `<p>Publishing Plan · ${session.publishingPlan.plannedClips ?? session.publishingPlan.clips?.length ?? 0} MP4 valid · ${session.publishingPlan.dailyPlan?.length ?? session.publishingPlan.schedule?.length ?? 0} slot · ${session.publishingPlan.settings?.timezone || "UTC"}</p>` : ""}
          </div>
          <span class="status-chip">${session.status}</span>
          ${session.publishingPlanPath ? `<button class="secondary-action" data-open-publishing="${index}">Buka plan</button>` : ""}
          ${session.publishingPlan ? `<button class="secondary-action" data-copy-publishing="${index}">Copy judul</button>` : ""}
          <button class="secondary-action" data-open-session="${index}">Buka folder</button>
        </article>
      `
    )
    .join("");
}

function renderProviders() {
  const providerList = $("#providerList");
  if (!providerList) return;
  const payload = providerPayload();
  const provider = aiProviders[payload.providerType] || aiProviders.cloud;
  const model = payload.model ? payload.model : "Auto";
  const ready = Boolean(payload.baseUrl && payload.apiKey && payload.model);
  const statusText = $("#providerStatusText")?.textContent || "";
  const features = payload.aiFeatures || aiFeatureConfig();
  const activeFeatureCount = Object.values(features).filter(Boolean).length;
  if (isConnectedProviderStatus(statusText)) {
    setText("#aiModeTitle", `${provider.label} active ✓ · ${activeFeatureCount} module ON`);
  } else {
    setText("#aiModeTitle", `${provider.label} belum terhubung`);
  }
  providerList.innerHTML = providerTasks
    .map(
      ([toggleId, task, note]) => {
        const key = {
          aiHighlightToggle: "highlight",
          aiCaptionToggle: "caption",
          aiHookToggle: "hook",
          aiTitleToggle: "title"
        }[toggleId];
        const enabled = Boolean(features[key]);
        const engine = enabled && ready ? `${provider.label} · ${model}` : "Menunggu koneksi provider";
        return `
        <article class="provider-item ${enabled ? "" : "disabled"}">
          <div>
            <strong>${task}</strong>
            <span>${note} · ${enabled ? "AI ON" : "AI OFF"}</span>
          </div>
          <em>${engine}</em>
        </article>
      `;
      }
    )
    .join("");
}

async function openSessionFolder(index) {
  const session = sessions[Number(index)];
  const folder = session?.folder || session?.size;
  if (!folder) {
    toast("Folder output belum tersedia");
    return;
  }
  if (!window.cliper?.openFolder) {
    toast("Buka via .exe untuk membuka folder");
    return;
  }
  const result = await window.cliper.openFolder(folder);
  if (!result?.ok) {
    pushLog(`[output] ${result?.message || "Folder tidak bisa dibuka"}: ${folder}`);
    toast(result?.message || "Folder tidak bisa dibuka");
    return;
  }
  pushLog(`[output] folder dibuka: ${folder}`);
}

async function copyPublishingTitles(index) {
  const plan = sessions[Number(index)]?.publishingPlan;
  const titles = (plan?.clips || [])
    .filter((clip) => clip.readiness !== "not_recommended")
    .map((clip) => clip.title)
    .filter(Boolean);
  if (!titles.length) {
    toast("Belum ada judul publishing yang siap");
    return;
  }
  try {
    await navigator.clipboard.writeText(titles.join("\n"));
    toast(`${titles.length} judul disalin`);
  } catch {
    toast("Clipboard tidak dapat ditulis", { error: true });
  }
}

function providerPayload() {
  const providerType = selectedProviderType();
  const apiKey = $("#apiKey")?.value?.trim();
  const features = aiFeatureConfig();
  const selectedModel = $("#highlightModel")?.value?.trim() || (providerType === "cloud" ? aiProviders.cloud.model : "");
  const baseUrl = providerType === "cloud" ? aiProviders.cloud.baseUrl : $("#baseUrl")?.value?.trim();
  const maxTokensByModule = {
    test: 320,
    highlight: 1600,
    ranking: 1400,
    review: 1200,
    title: 480,
    hook: 420,
    caption: 700,
    tts: 360,
    publishing: 600,
    metadata: 500
  };
  const timeoutMsByModule = {
    test: 30000,
    highlight: 90000,
    ranking: 90000,
    review: 90000,
    title: 45000,
    hook: 45000,
    caption: 45000,
    tts: 45000,
    publishing: 45000,
    metadata: 45000,
    default: 45000
  };
  const aiRetryByModule = {
    highlight: 3,
    ranking: 2,
    review: 2,
    title: 2,
    hook: 2,
    caption: 2,
    tts: 2,
    publishing: 2,
    metadata: 2,
    test: 2,
    default: 2
  };
  return {
    providerType,
    baseUrl,
    apiKey,
    model: selectedModel,
    highlightModel: selectedModel,
    moduleModels: {
      highlight: selectedModel,
      ranking: selectedModel,
      caption: selectedModel,
      hook: selectedModel,
      title: selectedModel,
      tts: selectedModel,
      test: selectedModel
    },
    maxTokensByModule,
    timeoutMsByModule,
    aiRetryByModule,
    aiFeatures: features,
    timeoutMs: 30000
  };
}

function maskApiKey(key) {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function apiKeyFingerprint(key) {
  const value = String(key || "");
  if (!value) return "";
  return `${value.length}:${value.slice(0, 8)}:${value.slice(-8)}`;
}

function setProviderStatus(message, ok = false) {
  setText("#providerStatusText", message);
  const box = $("#providerStatusBox");
  if (box) {
    box.classList.toggle("ok", ok);
    box.classList.toggle("warning", !ok && message !== "Belum dites");
  }
  renderProviders();
}

function renderCloudConnectionStatus(hasKey = Boolean($("#apiKey")?.value?.trim())) {
  const summary = !hasKey
    ? "Cliper AI Cloud belum terhubung"
    : state.cloudConnectionOk
      ? "Cliper AI Cloud aktif"
      : "API key tersimpan · hubungkan untuk verifikasi";
  setText("#apiStatus", summary);
  setText("#aiModeTitle", state.cloudConnectionOk ? "Cliper AI Cloud aktif" : hasKey ? "Cliper AI Cloud perlu diverifikasi" : "Cliper AI Cloud belum terhubung");
}

async function showProcessingError(result, phase = "analyze", runId = state.processingRunId) {
  if (runId !== state.processingRunId || state.cancelRequested) {
    showProcessingCancelled(phase);
    return;
  }
  const message = String(result?.message || "Worker gagal tanpa detail error.").trim();
  clearInterval(state.processingTimer);
  state.processingTimer = null;
  state.jobMode = phase === "render" ? "render" : "analyze";
  state.renderStartedAt = state.renderStartedAt || Date.now();

  let cancelled = false;
  if (window.cliper?.cancel) {
    try {
      const cancelResult = await window.cliper.cancel();
      cancelled = Boolean(cancelResult?.ok);
    } catch (error) {
      pushLog(`[cancel] worker error cleanup gagal: ${error.message}`);
    }
  }

  $("#jobBadge").textContent = "Error";
  $("#cancelJob").disabled = true;
  setText("#renderScreenTitle", phase === "render" ? "Render gagal" : "Analisis gagal");
  setText("#renderScreenSubtitle", message);
  updateRenderStats({ progress: state.progress || 0, stage: "Error" });
  setProcessingError(message, phase);
  const errorLine = `[error] ${message}`;
  const errorAlreadyLogged = state.logLines.slice(-4).some((line) => String(line).trim() === errorLine);
  if (!errorAlreadyLogged) pushLog(errorLine);
  if (cancelled) pushLog("[cancelled] worker dibatalkan otomatis setelah error");
  toast(message, { error: true, duration: 12000 });
  if (/\b(AUTH_REQUIRED|SESSION_UPDATE_REQUIRED|COOKIE_INVALID|COOKIE_EXPIRED)\b/i.test(message)) {
    state.pendingSessionResume = { phase, attempts: 0 };
    setView("settings");
    setSettingsTab("cookies");
    toast("YouTube Session perlu diperbarui. Analisis akan dilanjutkan setelah session valid.", {
      error: true,
      duration: 12000
    });
  }
}

async function resumePendingSessionJob() {
  const pending = state.pendingSessionResume;
  if (!pending || pending.attempts >= 1) return;
  state.pendingSessionResume = null;
  toast("Session valid. Melanjutkan pekerjaan sebelumnya...");
  if (pending.phase === "render") {
    await startProcessing();
  } else {
    await findMoments();
  }
}

function isConnectedProviderStatus(status) {
  const text = String(status || "");
  return /connected|valid|sukses|ready|ai router ok/i.test(text) || /\b(active|aktif)\b/i.test(text);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeAiUsage(value = {}) {
  const date = value.date === todayKey() ? value.date : todayKey();
  return {
    date,
    inputTokens: value.date === date ? Number(value.inputTokens || 0) : 0,
    outputTokens: value.date === date ? Number(value.outputTokens || 0) : 0,
    estimatedCostRp: value.date === date ? Number(value.estimatedCostRp || 0) : 0
  };
}

function addAiUsage(usage = {}) {
  const total = usage.usage_total || usage;
  const input = Number(total.input_tokens || total.prompt_tokens || total.inputTokens || 0);
  const output = Number(total.output_tokens || total.completion_tokens || total.outputTokens || 0);
  if (!input && !output) {
    renderAiUsage();
    return;
  }
  const current = normalizeAiUsage(state.aiUsageToday);
  state.aiUsageToday = {
    date: todayKey(),
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + output,
    estimatedCostRp: 0
  };
  renderAiUsage();
}

function renderAiUsage() {
  const usage = normalizeAiUsage(state.aiUsageToday);
  state.aiUsageToday = usage;
  setText("#aiTokenSummary", `${usage.inputTokens.toLocaleString("id-ID")} input / ${usage.outputTokens.toLocaleString("id-ID")} output tokens`);
  setText("#aiCostSummary", "Billing dan biaya provider dihitung oleh Cliper Cloud");
}

function providerErrorMessage(status, payload) {
  const text = String(status || "Test API gagal");
  if (/provider.*(?:belum|tidak).*(?:aktif|siap|tersedia)|router.*(?:belum|tidak).*(?:siap|tersedia)|provider setup/i.test(text)) {
    return "Cliper Cloud terhubung, tetapi AI provider belum disiapkan oleh admin";
  }
  if (/invalid|unauthorized|401|forbidden|api key/i.test(text)) {
    return `Invalid API key - pastikan key cocok untuk ${aiProviders[payload.providerType]?.label || payload.providerType}`;
  }
  if (/rate limit|rate_limit|429|too many requests/i.test(text)) {
    return "Rate Limited - tunggu sebentar atau gunakan provider lain";
  }
  if (/network|enotfound|econn|fetch failed|getaddrinfo|internet/i.test(text)) {
    return "Network Error - cek internet atau endpoint provider";
  }
  if (/response kosong|empty response|tidak mengembalikan jawaban/i.test(text)) {
    return "Connected but empty response - cek model, endpoint, atau format provider";
  }
  if (/model.*not found|model not found|not_found/i.test(text)) {
    return "Model routing Cloud tidak tersedia - coba hubungkan ulang Cliper AI Cloud";
  }
  if (/timeout|timed out/i.test(text)) {
    return "Connection Timeout - cek koneksi atau Base URL";
  }
  return text;
}

function applyProviderDefaults(force = false) {
  const providerType = selectedProviderType();
  const provider = aiProviders[providerType] || aiProviders.cloud;
  const base = $("#baseUrl");
  const key = $("#apiKey");
  const model = $("#highlightModel");
  if (base) {
    if (providerType === "cloud") {
      base.value = provider.baseUrl;
    } else if (force && !base.value) {
      base.value = "";
    }
    base.readOnly = provider.readonly;
    base.placeholder = providerType === "cloud" ? provider.baseUrl : "https://api.openai.com/v1";
  }
  if (model) {
    if (providerType === "cloud" || !model.value) {
      model.value = provider.model || "";
    }
    model.readOnly = provider.readonly;
    model.placeholder = providerType === "cloud" ? "" : "deepseek-chat, gpt-4.1, o4-mini, claude-sonnet-4, llama3.3, auto";
  }
  if (key) {
    key.disabled = false;
    key.placeholder = "clip_sk_xxxxxxxxx";
  }
  const connected = isConnectedProviderStatus($("#providerStatusText")?.textContent || "");
  setProviderStatus(key?.value?.trim() ? (connected ? $("#providerStatusText").textContent : "API key tersimpan · test connection") : `${provider.label} belum terhubung`, connected);
  renderCloudConnectionStatus(Boolean(key?.value?.trim()));
  const settingsPanel = document.querySelector(".settings-form");
  if (settingsPanel) {
    settingsPanel.classList.toggle("provider-cloud", providerType === "cloud");
  }
  updateTestButtonLabel();
  updateModelHelpText();
  renderProviders();
}

async function testProvider(options = {}) {
  const payload = providerPayload();
  const provider = aiProviders[payload.providerType] || aiProviders.cloud;
  if (!payload.apiKey) {
    const status = `API key ${provider.label} wajib diisi`;
    setProviderStatus(status, false);
    renderCloudConnectionStatus(false);
    if (!options.silent) toast(status);
    return { ok: false, status };
  }
  if (!payload.baseUrl) {
    const status = `Base URL ${provider.label} wajib diisi`;
    setProviderStatus(status, false);
    renderCloudConnectionStatus(false);
    if (!options.silent) toast(status);
    return { ok: false, status };
  }
  if (!payload.model) {
    const status = `Model ${provider.label} wajib diisi`;
    setProviderStatus(status, false);
    renderCloudConnectionStatus(false);
    if (!options.silent) toast(status);
    return { ok: false, status };
  }
  if (!window.cliper?.testProvider) {
    setProviderStatus("Test API tersedia di .exe", false);
    toast("Buka via .exe untuk Test API");
    return null;
  }
  const maskedKey = maskApiKey(payload.apiKey);
  setProviderStatus("Testing API...", true);
  await saveConfig({ silent: true });
  pushLog(`[ai] Test API request sent to ${provider.label}, model=${payload.model}, key=${maskedKey}`);
  const start = performance.now();
  const result = await window.cliper.testProvider(payload);
  const duration = Math.round(performance.now() - start);
  const response = result?.type === "done" ? result.result : result;
  if (result?.type === "error" || !response?.ok) {
    const status = response?.status || response?.message || result?.message || "Test API gagal";
    const message = providerErrorMessage(status, payload);
    state.cloudConnectionOk = false;
    state.cloudRouterReady = false;
    state.cloudConnectionKeyFingerprint = "";
    setProviderStatus(message, false);
    renderCloudConnectionStatus(Boolean(payload.apiKey));
    pushLog(`[ai] Test API failed provider=${payload.providerType} baseUrl=${payload.baseUrl} model=${payload.model} error=${status}`);
    toast(message);
    await saveConfig({ silent: true });
    return response || { ok: false, status };
  }
  const responseText = response.response || "OK";
  const usage = response.usage ? `usage=${JSON.stringify(response.usage)}` : "usage=unknown";
  addAiUsage(response.usage_total || response.usage || {});
  state.cloudRouterReady = response.routerReady !== false;
  const connectedStatus = response.routerReady === false
    ? "Cloud terhubung · AI provider belum disiapkan admin"
    : "Cloud terhubung · AI siap";
  setProviderStatus(connectedStatus, true);
  if (payload.providerType === "cloud") {
    state.cloudConnectionOk = true;
    state.cloudConnectionKeyFingerprint = apiKeyFingerprint(payload.apiKey);
  }
  renderCloudConnectionStatus(Boolean(payload.apiKey));
  pushLog(`[ai] Test API response received in ${duration}ms, ${usage}`);
  pushLog(`[ai] provider=${payload.providerType} model=${payload.model} response=${responseText}`);
  if (payload.providerType === "cloud" && response.license) {
    const walletState = response.license.unlimited ? "internal" : "server-managed";
    pushLog(`[cloud] billing_mode=${response.license.billingMode || "wallet"} status=${response.license.status || "active"} wallet=${walletState}`);
  }
  state.apiLastLatencyMs = duration;
  state.apiLastResponse = responseText;
  if (!options.silent) {
    toast(state.cloudRouterReady ? "Test API sukses" : "Cloud terhubung; admin perlu menyiapkan AI provider");
  }
  await saveConfig({ silent: true });
  return { ...response, latencyMs: duration };
}

function initializeProviderControls() {
  $$(".provider-card").forEach((card) => {
    card.addEventListener("click", () => {
      setSelectedProviderType(card.dataset.provider);
    });
    const input = card.querySelector("input[type='radio']");
    if (input) {
      input.addEventListener("change", () => {
        if (input.checked) setSelectedProviderType(input.value);
      });
    }
  });
  const baseInput = $("#baseUrl");
  if (baseInput) {
    baseInput.addEventListener("input", () => {
      setProviderStatus("API key tersimpan · test connection", false);
    });
  }
  const modelInput = $("#highlightModel");
  if (modelInput) {
    modelInput.addEventListener("input", () => {
      setProviderStatus("API key tersimpan · test connection", false);
    });
  }
}

function aiProviderRequiresConnectedStatus() {
  const payload = providerPayload();
  if (payload.providerType === "cloud") {
    if (!payload.apiKey) return true;
    if (state.cloudConnectionOk && state.cloudRouterReady && state.cloudConnectionKeyFingerprint === apiKeyFingerprint(payload.apiKey)) {
      return false;
    }
    const status = $("#providerStatusText")?.textContent || "";
    return !isConnectedProviderStatus(status);
  }
  return !payload.apiKey || !payload.baseUrl || !payload.model;
}

function drawPreview() {
  const canvas = $("#previewCanvas");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  if (state.previewImageUrl) {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const scale = Math.max(width / image.width, height / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      const x = (width - drawWidth) / 2;
      const y = (height - drawHeight) / 2;
      ctx.fillStyle = "#172026";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, x, y, drawWidth, drawHeight);
      ctx.fillStyle = "rgba(23,32,38,0.72)";
      ctx.fillRect(0, height - 92, width, 92);
      ctx.fillStyle = "#ffffff";
      ctx.font = "800 28px system-ui, sans-serif";
      ctx.fillText("Preview thumbnail YouTube", 42, height - 44);
    };
    image.onerror = () => {
      state.previewImageUrl = "";
      drawPreview();
    };
    image.src = state.previewImageUrl;
    return;
  }
  ctx.fillStyle = "#172026";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 30px system-ui, sans-serif";
  ctx.fillText("CLIPER STUDIO PLUS", 64, 120);
  ctx.fillStyle = "#dce7ec";
  ctx.font = "500 20px system-ui, sans-serif";
  ctx.fillText("Masukkan link YouTube untuk memulai analisa real.", 64, 166);
  ctx.fillStyle = "#d9a938";
  ctx.fillRect(64, 220, 280, 8);
}

async function scanSubtitles() {
  state.scanCount += 1;
  if (!window.cliper) {
    pushLog(`[scan] mode browser: worker Electron tidak tersedia (${state.scanCount})`);
    toast("Buka via .exe untuk scan nyata");
    return;
  }
  pushLog("[check] cek dependency worker");
  const result = await window.cliper.checkDependencies();
  const deps = result.result || {};
  state.dependencies = deps;
  renderRuntimeList(deps);
  setText("#subtitleMetric", deps.yt_dlp?.ok ? "Download siap" : "Perlu menyiapkan yt-dlp");
  // The top status pill reports Cloud authentication, not local FFmpeg state.
  // Runtime readiness is shown separately in #runtimeMetric.
  renderCloudConnectionStatus(Boolean($("#apiKey")?.value?.trim()));
  setText("#runtimeMetric", deps.ffmpeg?.ok ? "Sistem siap" : "Sistem perlu disiapkan");
  refreshHardwareStatus(deps);
  pushLog(`[dependency] python=${deps.python?.version || "-"} yt-dlp=${deps.yt_dlp?.ok ? deps.yt_dlp.version : "missing"} ffmpeg=${deps.ffmpeg?.ok ? "ready" : "missing"}`);
  const status = $("#runtimeInstallStatus");
  if (status) {
    status.classList.remove("error", "running");
    status.textContent = deps.ffmpeg?.ok && deps.yt_dlp?.ok
      ? "Sistem inti siap. Komponen opsional akan dipakai otomatis bila tersedia."
      : "Ada komponen inti yang belum siap. Gunakan Siapkan sistem untuk memasangnya.";
  }
  toast("Sistem diperiksa");
}

async function findMoments() {
  setSourceMode("youtube");
  const requestedClipCount = normalizeRequestedClipCount($("#clipCount").value);
  syncClipTargetControls(requestedClipCount);
  const target = requestedClipCount;
  if (!$("#youtubeUrl").value.trim()) {
    toast("Masukkan YouTube URL dulu");
    return;
  }
  if (!window.cliper) {
    pushLog(`[browser] worker Electron tidak tersedia untuk analyze real (${target})`);
    renderMoments();
    toast("Buka via .exe untuk analisa real");
    return;
  }
  if (aiProviderRequiresConnectedStatus()) {
    setView("settings");
    setSettingsTab("api");
    const payload = providerPayload();
    const provider = aiProviders[payload.providerType] || aiProviders.cloud;
    const message = payload.apiKey
      ? `Test API ${provider.label} dulu sampai Connected.`
      : `Masukkan API key ${provider.label} terlebih dahulu.`;
    pushLog(`[ai] analisa diblokir: ${message}`);
    toast(message);
    return;
  }
  const url = $("#youtubeUrl").value.trim();
  if (!state.videoDuration || metadataUrl !== url) {
    const metadataReady = await fetchMetadata(url);
    if (!metadataReady) {
      toast("Metadata dan durasi video belum berhasil dimuat");
      return;
    }
  }
  const selection = currentAnalysisSelection();
  if (!selection.valid) {
    toast(selection.message);
    pushLog(`[timeline] analisa diblokir: ${selection.message}`);
    return;
  }

  clearInterval(state.processingTimer);
  const runId = ++state.processingRunId;
  state.cancelRequested = false;
  clearProcessingError();
  state.progress = 0;
  resetStepStatus("analyze");
  $("#progressBar").style.width = "0%";
  $("#jobBadge").textContent = "Analyzing";
  $("#cancelJob").disabled = false;
  setText("#renderScreenTitle", "Mencari moment terbaik...");
  setText("#renderScreenSubtitle", "Mengambil transcript dan memahami isi video dengan AI.");
  updateRenderStats({ progress: 0, stage: "Download subtitle", clipIndex: null, totalClips: null });
  renderSteps();
  const areaText = selection.mode === "full"
    ? `full ${formatDuration(selection.duration)}`
    : `${selection.ranges.map(([start, end]) => `${formatDuration(start)}-${formatDuration(end)}`).join(", ")} · total ${formatDuration(selection.selectedDuration)}`;
  pushLog(`[analyze] mulai analisa nyata: ${$("#youtubeUrl").value} · area=${areaText}`);
  setView("render");
  const result = await window.cliper.analyze({
    ...collectPayload(),
    videoDuration: selection.duration,
    sourceDuration: selection.duration,
    analysisRanges: selection.ranges,
  });
  if (runId !== state.processingRunId) return;
  if (result.type === "error") {
    await showProcessingError(result, "analyze", runId);
    return;
  }

  clearProcessingError();
  state.cancelRequested = false;
  const data = result.result || {};
  addAiUsage(data.ai_usage || {});
  const diagnostics = data.ai_diagnostics || {};
  const provider = aiProviders[providerPayload().providerType] || aiProviders.cloud;
  const aiStatus = diagnostics.ai_used
    ? `${provider.label} aktif · ${diagnostics.requests || 0} request · ${diagnostics.retry_count || 0} retry`
    : `Fallback internal${diagnostics.last_fallback_reason ? ` · ${diagnostics.last_fallback_reason}` : ""}`;
  setText("#aiPipelineStatus", aiStatus);
  pushLog(`[ai diagnostics] used=${Boolean(diagnostics.ai_used)} provider=${diagnostics.provider || "-"} model=${diagnostics.model || "-"} requests=${diagnostics.requests || 0} retries=${diagnostics.retry_count || 0} fallback=${diagnostics.fallback_events || 0}`);
  if (diagnostics.last_fallback_reason) {
    pushLog(`[ai fallback] ${diagnostics.last_fallback_reason}`);
  }
  if (data.ai_debug_path) {
    pushLog(`[ai debug] ${data.ai_debug_path}`);
  }
  state.lastAnalysis = data;
  const heatmap = data.video?.heatmap;
  if (heatmap) {
    pushLog(
      `[heatmap] status=${heatmap.status || "unavailable"} markers=${Number(heatmap.markerCount || 0)} peaks=${Number(heatmap.peakCount || 0)}`
    );
  }
  renderRuntimeList(state.dependencies);
  state.lastTranscript = Array.isArray(data.transcript) ? normalizeTranscriptSegments(data.transcript) : [];
  state.videoDuration = Number(data.video?.duration || state.videoDuration || 0);
  if (data.video?.used_cookies) {
    await markCookiesUsed();
    pushLog("[cookies] digunakan otomatis setelah video meminta login/age verification");
  }
  if (data.video?.source_path) {
    pushLog(`[cache] ${data.video.cache_status === "cached" ? "Using cached source" : "Source cached"}: ${data.video.source_path}`);
  }
  const workerRanges = Array.isArray(data.video?.analysis_ranges) ? data.video.analysis_ranges : [];
  const returnedRanges = selection.mode === "full"
    ? []
    : (workerRanges.length ? workerRanges : selection.ranges);
  if (selection.mode !== "full" && !workerRanges.length) {
    pushLog("[timeline] worker tidak mengembalikan analysis_ranges; UI memakai selected range lokal sebagai batas aman");
  }
  const rawMoments = Array.isArray(data.moments) ? data.moments : [];
  const safeMoments = rawMoments.filter((item) => momentInsideAnalysisRanges(item, returnedRanges));
  if (safeMoments.length !== rawMoments.length) {
    pushLog(`[timeline] ${rawMoments.length - safeMoments.length} kandidat di luar selected range dibuang oleh UI safety check`);
  }
  momentBank = safeMoments.map((item, index) => normalizeMomentForUi(item, index, data.video || {}));
  applyMomentDisplayPolicy();
  if (!momentBank.length) {
    pushLog("[highlight] worker selesai tanpa moment; empty-state ditampilkan dan UI tetap responsif");
  }
  // Automatically select only high-confidence recommendations. Optional and
  // review candidates remain visible and can be selected manually.
  state.selectedMoments = new Set(momentBank.filter((item) => item.autoRender).map((item) => item.id));
  state.activeMomentId = momentBank[0]?.id || null;
  $("#previewTitle").textContent = data.video?.title || "YouTube video";
  $("#previewUrl").textContent = data.video?.webpage_url || $("#youtubeUrl").value;
  $("#subtitleMetric").textContent = data.video?.subtitle_language || "No subtitle";
  $("#previewScore").textContent = momentBank[0] ? momentQualityDisplay(momentBank[0]) : "-";
  state.previewImageUrl = data.video?.thumbnail || "";
  drawPreview();
  $("#jobBadge").textContent = "Ready";
  renderMoments();
  renderMomentReview();
  renderPipelinePreview();
  updateTimelinePreview();
  setView("moments");
  toast("Moment nyata siap dipilih");
}

async function startProcessing() {
  const clips = selectedMoments();
  if (clips.length === 0) {
    toast("Pilih minimal 1 moment");
    return;
  }
  const payload = collectPayload();
  if (aiProviderRequiresConnectedStatus()) {
    setView("settings");
    setSettingsTab("api");
    const provider = aiProviders[payload.providerType] || aiProviders.cloud;
    const message = payload.apiKey
      ? `Test API ${provider.label} dulu sampai Connected.`
      : `Masukkan API key ${provider.label} terlebih dahulu.`;
    pushLog(`[ai] render diblokir: ${message}`);
    toast(message);
    return;
  }

  if (window.cliper) {
    clearInterval(state.processingTimer);
    const runId = ++state.processingRunId;
    state.cancelRequested = false;
    clearProcessingError();
    state.progress = 0;
    state.renderErrors = [];
    resetStepStatus("render");
    state.renderStartedAt = Date.now();
    setText("#renderScreenTitle", "Memproses clip...");
    setText("#renderScreenSubtitle", `Menyiapkan ${clips.length} clip dengan pipeline produksi otomatis.`);
    updateRenderStats({ progress: 0, stage: "Download video sections", clipIndex: 1, totalClips: clips.length });
    renderPipelinePreview();
    renderSteps();
    $("#jobBadge").textContent = "Rendering";
    $("#cancelJob").disabled = false;
    pushLog(`[render] mulai render nyata ${clips.length} clip`);
    setView("render");
    const result = await window.cliper.render({ ...collectPayload(), moments: selectedMomentPayload() });
    if (runId !== state.processingRunId) return;
    if (result.type === "error") {
      await showProcessingError(result, "render", runId);
      return;
    }
    clearProcessingError();
    state.cancelRequested = false;
    if (result.result?.manifest?.used_cookies) {
      await markCookiesUsed();
      pushLog("[cookies] render berhasil memakai cookies setelah retry otomatis");
    }
    if (result.result?.manifest?.source_path) {
      pushLog(`[cache] render source: ${result.result.manifest.source_path}`);
    }
    const manifest = result.result?.manifest || {};
    addAiUsage(manifest.ai_usage || {});
    const requestedCount = Number(manifest.requested_clip_count || clips.length || 0);
    const validCount = Number(manifest.valid_mp4_count || 0);
    const shortage = requestedCount > validCount;
    const warningCount = state.renderErrors.length + (manifest.warnings?.length || 0) + (shortage ? 1 : 0);
    const outputs = result.result?.outputs || [];
    const outputCount = validCount;
    $("#jobBadge").textContent = outputCount ? "Complete" : "Error";
    sessions.unshift({
      name: result.result?.manifest?.title || "YouTube clip session",
      clips: outputCount,
      date: "Baru saja",
      status: outputCount ? (warningCount ? `Selesai + warning (${validCount}/${requestedCount})` : "Selesai") : "Gagal",
      size: result.result?.sessionDir || "Lihat folder",
      folder: result.result?.sessionDir || "",
      publishingPlan: manifest.publishingPlanner?.plan || null,
      publishingPlanPath: manifest.publishingPlanner?.planPath || ""
    });
    renderSessions();
    pushLog(`[done] output: ${result.result?.sessionDir || "-"}`);
    pushLog(`[summary] requested=${requestedCount} valid=${validCount} failed=${Number(manifest.failed_count || 0)} ai=${manifest.ai_provider || "-"}`);
    toast(outputCount ? (warningCount ? "Render selesai dengan warning" : "Render selesai") : "Render gagal");
    setView("outputs");
    return;
  }

  toast("Buka via .exe untuk render real");
}

function buildConfig() {
  const providerType = selectedProviderType();
  const modelValue = fieldValue("highlightModel", providerType === "cloud" ? aiProviders.cloud.model : "");
  const rendererSettings = getProductionRenderPreset();
  const config = {
    settingsContractVersion: Number(state.settingsContract?.version || 1),
    featureFlags: { ...(state.settingsContract?.featureFlags || {}) },
    rendererSettings: { ...rendererSettings },
    ...rendererSettings,
    providerType,
    baseUrl: providerType === "cloud" ? aiProviders.cloud.baseUrl : fieldValue("baseUrl", ""),
    apiKey: fieldValue("apiKey"),
    model: modelValue,
    highlightModel: modelValue,
    aiHighlightToggle: fieldValue("aiHighlightToggle", true),
    aiHookToggle: fieldValue("aiHookToggle", true),
    aiCaptionToggle: fieldValue("aiCaptionToggle", true),
    aiTitleToggle: fieldValue("aiTitleToggle", true),
    providerStatus: $("#providerStatusText")?.textContent || "Cliper AI Cloud belum terhubung",
    apiStatus: $("#apiStatus")?.textContent || "Cliper AI Cloud belum terhubung",
    cloudConnectionOk: state.cloudConnectionOk,
    cloudRouterReady: state.cloudRouterReady,
    cloudConnectionKeyFingerprint: state.cloudConnectionKeyFingerprint,
    apiLastTestedAt: state.apiLastTestedAt || "",
    apiLastLatencyMs: state.apiLastLatencyMs || 0,
    apiLastResponse: state.apiLastResponse || "",
    aiUsageToday: normalizeAiUsage(state.aiUsageToday),
    clipCount: String(normalizeRequestedClipCount(fieldValue("clipCount", "4"))),
    scoreMode: "Content-aware editor score",
    minDuration: fieldValue("minDuration", "30"),
    targetDuration: fieldValue("targetDuration", "75"),
    maxDuration: fieldValue("maxDuration", "180"),
    selectionMode: fieldValue("selectionMode", "full"),
    rangeStart: fieldValue("rangeStart", ""),
    rangeEnd: fieldValue("rangeEnd", ""),
    multipleRanges: fieldValue("multipleRanges", ""),
    outputFolder: fieldValue("outputFolder", "outputs/clips"),
    projectName: fieldValue("projectName", "Cliper Studio Plus"),
    ffmpegPath: fieldValue("ffmpegPath", ""),
    ffprobePath: fieldValue("ffprobePath", ""),
    overwriteExisting: fieldValue("overwriteExisting", false),
    autoRename: fieldValue("autoRename", true),
    createProjectFolder: fieldValue("createProjectFolder", true),
    deleteTempAfterExport: fieldValue("deleteTempAfterExport", true),
    outputQualityProfile: fieldValue("outputQualityProfile", "balanced"),
    smartPublishingPlanner: fieldValue("smartPublishingPlannerToggle", true),
    publishingPlatforms: [
      fieldValue("publishingYouTubeToggle", true) ? "youtube_shorts" : "",
      fieldValue("publishingInstagramToggle", true) ? "instagram_reels" : "",
      fieldValue("publishingTikTokToggle", true) ? "tiktok" : ""
    ].filter(Boolean),
    publishingTimezone: fieldValue("publishingTimezone", "Asia/Jakarta"),
    publishingPostsPerDay: fieldValue("publishingPostsPerDay", "2"),
    publishingMinimumGapHours: fieldValue("publishingMinimumGapHours", "4"),
    formatProfile: fieldValue("formatProfile", "9:16 YouTube Shorts"),
    resolutionProfile: fieldValue("resolutionProfile", "1080p"),
    crfProfile: fieldValue("crfProfile", "23"),
    fpsProfile: fieldValue("fpsProfile", "Same as source"),
    captionStyle: fieldValue("captionStyle", "TikTok style"),
    subtitleBurnToggle: rendererSettings.addCaptions && rendererSettings.burnSubtitle,
    hookOpeningToggle: rendererSettings.addHook,
    hookDuration: fieldValue("hookDuration", "3 seconds"),
    hookLayout: fieldValue("hookLayout", "auto"),
    subtitlePreviewInput: fieldValue("subtitlePreviewInput", "TAPI GUE HERAN"),
    subtitleFontFamily: fieldValue("subtitleFontFamily", "Arial Black"),
    subtitleFontPath: fieldValue("subtitleFontPath", ""),
    subtitleFontSize: fieldValue("subtitleFontSize", "84"),
    subtitleX: fieldValue("subtitleX", "50"),
    subtitleY: fieldValue("subtitleY", "82"),
    subtitlePrimaryColor: fieldValue("subtitlePrimaryColor", "#ffffff"),
    subtitleActiveColor: fieldValue("subtitleActiveColor", "#ffe600"),
    subtitleStrokeColor: fieldValue("subtitleStrokeColor", "#000000"),
    subtitleShadow: fieldValue("subtitleShadow", "3"),
    subtitleAnimation: fieldValue("subtitleAnimation", "Scale"),
    subtitleLetterSpacing: fieldValue("subtitleLetterSpacing", "1.1"),
    subtitlePreset: fieldValue("subtitlePreset", "capcut"),
    subtitleWordHighlight: fieldValue("subtitleWordHighlightToggle", true),
    overlayGeometryVersion: 2,
    ttsHookToggle: rendererSettings.addTtsHook,
    audioEnhanceToggle: rendererSettings.audioEnhance,
    thumbnailPreviewToggle: fieldValue("thumbnailPreviewToggle", false),
    watermarkEnabled: fieldValue("watermarkEnabled", false),
    watermarkInOutput: fieldValue("watermarkInOutput", false),
    logoAssetPath: fieldValue("logoAssetPath", ""),
    logoX: fieldValue("logoX", "84"),
    logoY: fieldValue("logoY", "12"),
    logoScale: fieldValue("logoScale", "18"),
    logoOpacity: fieldValue("logoOpacity", "90"),
    logoRotation: fieldValue("logoRotation", "0"),
    watermarkText: fieldValue("watermarkText"),
    watermarkOpacity: fieldValue("watermarkOpacity", "68"),
    watermarkPosition: fieldValue("watermarkPosition", "Top right"),
    watermarkTextX: fieldValue("watermarkTextX", "82"),
    watermarkTextY: fieldValue("watermarkTextY", "20"),
    watermarkTextSize: fieldValue("watermarkTextSize", "42"),
    watermarkTextColor: fieldValue("watermarkTextColor", "#ffffff"),
    watermarkTextStroke: fieldValue("watermarkTextStroke", "#000000"),
    watermarkTextShadow: fieldValue("watermarkTextShadow", "2"),
    watermarkFontFamily: fieldValue("watermarkFontFamily", "Arial Black"),
    watermarkFontPath: fieldValue("watermarkFontPath", ""),
    gpuToggle: rendererSettings.gpuAcceleration,
    cookies_path: state.cookiesPath || "",
    cookies_last_import: state.cookiesInfo?.importedAt || "",
    cookies_last_test: state.cookiesInfo?.lastTest || "",
    cookies_last_used: state.cookiesInfo?.lastUsed || "",
    cookies_status: state.cookiesInfo?.status || "",
    cookies_test_status: state.cookiesInfo?.testStatus || "",
    cookies_test_url: state.cookiesInfo?.testUrl || "",
    cookies_meta: state.cookiesInfo
  };
  return config;
}

function applyConfig(config = {}) {
  const rendererSettings = normalizeRendererSettings(config);
  config = {
    ...config,
    ...rendererSettings,
    rendererSettings,
    subtitleBurnToggle: rendererSettings.addCaptions && rendererSettings.burnSubtitle,
    hookOpeningToggle: rendererSettings.addHook,
    ttsHookToggle: rendererSettings.addTtsHook,
    audioEnhanceToggle: rendererSettings.audioEnhance,
    gpuToggle: rendererSettings.gpuAcceleration
  };
  const providerType = "cloud";
  const legacyGeometry = Number(config.overlayGeometryVersion || 1) < 2;
  const savedSubtitleSize = Number(config.subtitleFontSize || 56);
  const savedWatermarkSize = Number(config.watermarkTextSize || 28);
  const subtitleFontSize = legacyGeometry && savedSubtitleSize <= 64
    ? Math.min(128, Math.round(savedSubtitleSize * 1.5))
    : Math.max(40, Math.min(128, savedSubtitleSize || 84));
  const watermarkTextSize = legacyGeometry && savedWatermarkSize <= 36
    ? Math.min(96, Math.round(savedWatermarkSize * 1.5))
    : Math.max(20, Math.min(96, savedWatermarkSize || 42));
  const configuredCloudUrl = normalizeCloudEndpoint(config.cloudBaseUrl || config.baseUrl);
  aiProviders.cloud.baseUrl = configuredCloudUrl;
  state.config = { ...config, providerType, overlayGeometryVersion: 2 };
  state.cloudConnectionOk = Boolean(config.cloudConnectionOk && config.apiKey && isConnectedProviderStatus(config.providerStatus));
  state.cloudRouterReady = Boolean(config.cloudRouterReady && state.cloudConnectionOk);
  state.cloudConnectionKeyFingerprint = state.cloudConnectionOk
    ? (config.cloudConnectionKeyFingerprint || apiKeyFingerprint(config.apiKey))
    : "";
  setValue("#providerType", providerType);
  setValue("#baseUrl", providerType === "cloud" ? aiProviders.cloud.baseUrl : config.baseUrl || "");
  setValue("#apiKey", config.apiKey || "");
  setValue("#highlightModel", providerType === "cloud" ? aiProviders.cloud.model : config.model || config.highlightModel || "");
  const connectedProviderStatus = state.cloudRouterReady
    ? "Cloud terhubung · AI siap"
    : state.cloudConnectionOk
      ? "Cloud terhubung · AI provider belum disiapkan admin"
      : "Belum dites";
  setText(
    "#providerStatusText",
    isConnectedProviderStatus(config.providerStatus) ? connectedProviderStatus : "Belum dites"
  );
  applyProviderDefaults(false);
  setValue("#aiHighlightToggle", config.aiHighlightToggle ?? true);
  setValue("#aiHookToggle", config.aiHookToggle ?? true);
  setValue("#aiCaptionToggle", config.aiCaptionToggle ?? true);
  setValue("#aiTitleToggle", config.aiTitleToggle ?? true);
  syncClipTargetControls(config.clipCount ?? 4);
  setValue("#scoreMode", config.scoreMode || "Content-aware editor score");
  setValue("#minDuration", config.minDuration || "30");
  setValue("#targetDuration", config.targetDuration || "75");
  setValue("#maxDuration", config.maxDuration || "180");
  setValue("#selectionMode", config.selectionMode || "full");
  setValue("#rangeStart", config.rangeStart || "");
  setValue("#rangeEnd", config.rangeEnd || "");
  setValue("#multipleRanges", config.multipleRanges || "");
  setValue("#outputFolder", config.outputFolder || "outputs/clips");
  setValue("#projectName", config.projectName || "Cliper Studio Plus");
  setValue("#ffmpegPath", config.ffmpegPath || "");
  setValue("#ffprobePath", config.ffprobePath || "");
  setValue("#outputQualityProfile", config.outputQualityProfile || "balanced");
  setValue("#smartPublishingPlannerToggle", config.smartPublishingPlanner ?? true);
  const publishingPlatforms = new Set(config.publishingPlatforms || ["youtube_shorts", "instagram_reels", "tiktok"]);
  setValue("#publishingYouTubeToggle", publishingPlatforms.has("youtube_shorts"));
  setValue("#publishingInstagramToggle", publishingPlatforms.has("instagram_reels"));
  setValue("#publishingTikTokToggle", publishingPlatforms.has("tiktok"));
  setValue("#publishingTimezone", config.publishingTimezone || "Asia/Jakarta");
  setValue("#publishingPostsPerDay", config.publishingPostsPerDay || "2");
  setValue("#publishingMinimumGapHours", config.publishingMinimumGapHours || "4");
  setValue("#formatProfile", config.formatProfile || "9:16 YouTube Shorts");
  state.apiLastTestedAt = config.apiLastTestedAt || "";
  state.apiLastLatencyMs = config.apiLastLatencyMs || 0;
  state.apiLastResponse = config.apiLastResponse || "";
  state.aiUsageToday = normalizeAiUsage(config.aiUsageToday || {});
  setValue("#resolutionProfile", config.resolutionProfile || "1080p");
  setValue("#crfProfile", config.crfProfile || "23");
  setValue("#fpsProfile", config.fpsProfile || "Same as source");
  setValue("#captionStyle", config.captionStyle || "TikTok style");
  setValue("#subtitleBurnToggle", rendererSettings.addCaptions && rendererSettings.burnSubtitle);
  setValue("#hookOpeningToggle", rendererSettings.addHook);
  setValue("#hookDuration", config.hookDuration || "3 seconds");
  setValue("#hookLayout", config.hookLayout || "auto");
  setValue("#subtitlePreviewInput", config.subtitlePreviewInput || "TAPI GUE HERAN");
  setValue("#subtitleWordHighlightToggle", config.subtitleWordHighlight ?? true);
  setValue("#subtitleFontFamily", config.subtitleFontFamily || "Arial Black");
  setValue("#subtitleFontPath", config.subtitleFontPath || "");
  setValue("#subtitleFontSize", subtitleFontSize);
  setValue("#subtitleX", config.subtitleX ?? "50");
  setValue("#subtitleY", config.subtitleY ?? "82");
  setValue("#subtitlePrimaryColor", config.subtitlePrimaryColor || "#ffffff");
  setValue("#subtitleActiveColor", config.subtitleActiveColor || "#ffe600");
  setValue("#subtitleStrokeColor", config.subtitleStrokeColor || "#000000");
  setValue("#subtitleShadow", config.subtitleShadow || "3");
  setValue("#subtitleAnimation", config.subtitleAnimation || "Scale");
  setValue("#subtitleLetterSpacing", config.subtitleLetterSpacing ?? "1.1");
  const hasSavedSubtitleStyle = [
    "captionStyle",
    "subtitleFontFamily",
    "subtitleFontSize",
    "subtitleActiveColor",
    "subtitleAnimation",
  ].some((key) => Object.prototype.hasOwnProperty.call(config, key));
  markSubtitlePreset(config.subtitlePreset || (hasSavedSubtitleStyle ? "" : "capcut"));
  setValue("#ttsHookToggle", rendererSettings.addTtsHook);
  setValue("#audioEnhanceToggle", rendererSettings.audioEnhance);
  setValue("#smartCropToggle", rendererSettings.smartCrop);
  setValue("#dynamicZoomToggle", rendererSettings.dynamicZoom);
  setValue("#faceTrackToggle", rendererSettings.faceTrack);
  setValue("#autoCutToggle", rendererSettings.autoCut);
  setValue("#autoVideoEnhancementToggle", rendererSettings.autoVideoEnhancement);
  setValue("#thumbnailPreviewToggle", config.thumbnailPreviewToggle ?? false);
  setValue("#watermarkEnabled", config.watermarkEnabled ?? false);
  setValue("#watermarkInOutput", config.watermarkInOutput ?? false);
  setValue("#logoAssetPath", config.logoAssetPath || "");
  setValue("#logoX", config.logoX ?? "84");
  setValue("#logoY", Math.max(Number(config.logoScale || 18) / 2, Number(config.logoY ?? 12)));
  setValue("#logoScale", config.logoScale || "18");
  setValue("#logoOpacity", config.logoOpacity || "90");
  setValue("#logoRotation", config.logoRotation || "0");
  setValue("#watermarkText", config.watermarkText || "");
  setValue("#watermarkOpacity", config.watermarkOpacity || "68");
  setValue("#watermarkPosition", config.watermarkPosition || "Top right");
  setValue("#watermarkTextX", config.watermarkTextX ?? "82");
  setValue("#watermarkTextY", config.watermarkTextY ?? "20");
  setValue("#watermarkTextSize", watermarkTextSize);
  setValue("#watermarkTextColor", config.watermarkTextColor || "#ffffff");
  setValue("#watermarkTextStroke", config.watermarkTextStroke || "#000000");
  setValue("#watermarkTextShadow", config.watermarkTextShadow || "2");
  setValue("#watermarkFontFamily", config.watermarkFontFamily || "Arial Black");
  setValue("#watermarkFontPath", config.watermarkFontPath || "");
  setValue("#gpuToggle", rendererSettings.gpuAcceleration);
  setValue("#overwriteExisting", config.overwriteExisting ?? false);
  setValue("#autoRename", config.autoRename ?? true);
  setValue("#createProjectFolder", config.createProjectFolder ?? true);
  setValue("#deleteTempAfterExport", config.deleteTempAfterExport ?? true);
  syncRendererSettingDependencies();
  state.cookiesInfo = normalizeCookiesInfo(config);
  state.cookiesPath = state.cookiesInfo?.path || "";
  renderCloudConnectionStatus(Boolean(config.apiKey));
  applyProviderDefaults(false);
  renderProviders();
  renderCookiesManager();
  updateTimelinePreview();
  updateBrandPreview();
  updateSubtitlePreview();
  renderAiUsage();
}

async function saveConfig(options = {}) {
  const config = buildConfig();
  state.config = config;
  const browserSafeConfig = { ...config };
  delete browserSafeConfig.apiKey;
  localStorage.setItem("cliper-config", JSON.stringify(browserSafeConfig));
  if (window.cliper?.saveConfig) {
    try {
      await window.cliper.saveConfig(config);
    } catch (error) {
      pushLog(`[config] gagal menyimpan config.json: ${error.message}`);
    }
  }
  renderCloudConnectionStatus(Boolean(config.apiKey));
  renderProviders();
  renderCookiesManager();
  if (!options.silent) toast("Setting disimpan");
}

async function loadConfig() {
  let config = {};
  try {
    config = JSON.parse(localStorage.getItem("cliper-config") || "{}");
  } catch (error) {
    localStorage.removeItem("cliper-config");
    pushLog(`[config] localStorage config rusak, dibersihkan: ${error.message}`);
  }
  if (window.cliper?.getConfig) {
    try {
      const fileConfig = await window.cliper.getConfig();
      if (typeof fileConfig === "object" && fileConfig !== null) {
        config = { ...config, ...fileConfig };
      }
    } catch (error) {
      try {
        const brokenPath = await window.cliper.getConfigPath?.();
        if (brokenPath) {
          await window.cliper.saveConfig({ ...config, _backupBrokenConfig: true });
        }
      } catch {}
      pushLog(`[config] gagal membaca config.json: ${error.message}`);
    }
  }
  // The main process owns the endpoint decision. This keeps a packaged app from
  // ever falling back to a stale browser cache or localhost when config recovery fails.
  if (window.cliper?.getRuntimeDefaults) {
    try {
      const runtimeDefaults = await window.cliper.getRuntimeDefaults();
      if (typeof runtimeDefaults?.appVersion === "string" && runtimeDefaults.appVersion.trim()) {
        appVersion = runtimeDefaults.appVersion.trim();
      }
      if (runtimeDefaults?.cloudBaseUrl) {
        config = {
          ...config,
          providerType: "cloud",
          baseUrl: runtimeDefaults.cloudBaseUrl,
          cloudBaseUrl: runtimeDefaults.cloudBaseUrl
        };
      }
    } catch (error) {
      pushLog(`[config] gagal membaca endpoint runtime: ${error.message}`);
    }
  }
  if (window.cliper?.getYouTubeSession) {
    try {
      const youtubeSession = await window.cliper.getYouTubeSession();
      if (youtubeSession?.present) {
        config = {
          ...config,
          cookies_path: youtubeSession.path,
          cookiesPath: youtubeSession.path,
          cookies_meta: youtubeSession
        };
      } else {
        delete config.cookies_path;
        delete config.cookiesPath;
        delete config.cookies_meta;
      }
    } catch (error) {
      pushLog(`[auth] status YouTube Session tidak tersedia: ${error.message}`);
    }
  }
  const browserSafeConfig = { ...config };
  delete browserSafeConfig.apiKey;
  localStorage.setItem("cliper-config", JSON.stringify(browserSafeConfig));
  applyConfig(config);
}

async function validateAndStoreCookies(filePath) {
  if (!filePath) return;
  if (!window.cliper?.validateCookies) {
    state.cookiesPath = filePath;
    state.cookiesInfo = {
      path: filePath,
      fileName: filePath.split(/[\\/]/).pop() || "cookies.txt",
      sizeBytes: 0,
      importedAt: new Date().toISOString(),
      status: "Cookies Loaded",
      testStatus: "Belum dites"
    };
    await saveConfig({ silent: true });
    toast("Cookies dipilih. Validasi tersedia di .exe");
    return;
  }

  toast("Mengimpor YouTube Session...");
  setText("#cookiesTestStatus", "Memvalidasi session...");
  pushLog("[auth] validasi file YouTube Session lokal");
  const result = await window.cliper.validateCookies({ cookiesPath: filePath });
  const validation = result.result || {};
  if (result.type === "error" || !validation.ok) {
    const reason = validation.reason || result.message || "Cookies tidak valid. Silakan export ulang.";
    setText("#cookiesTestStatus", reason);
    pushLog(`[cookies] invalid: ${reason}`);
    toast("Cookies tidak valid. Silakan export ulang.");
    return;
  }

  const session = validation.session || {};
  state.cookiesPath = session.path || validation.path || filePath;
  state.cookiesInfo = normalizeCookiesInfo({
    cookies_path: state.cookiesPath,
    cookies_meta: {
      ...session,
      state: session.state || "SESSION_PRESENT",
      reason: validation.warning || null
    }
  });
  await saveConfig({ silent: true });
  renderCookiesManager();
  pushLog("[auth] YouTube Session tersimpan secara lokal.");
  toast("YouTube Session berhasil disimpan.");
  await resumePendingSessionJob();
}

async function importCookies() {
  if (window.cliper?.selectCookieFile) {
    const filePath = await window.cliper.selectCookieFile();
    await validateAndStoreCookies(filePath);
    return;
  }
  $("#cookieFile")?.click();
}

async function updateYouTubeSession() {
  if (!window.cliper?.updateYouTubeSession) {
    toast("Update browser tersedia di aplikasi desktop");
    return;
  }
  const browser = fieldValue("youtubeSessionBrowser", "chrome");
  const url = $("#youtubeUrl")?.value.trim() || "";
  const button = $("#importCookiesButton");
  if (button) button.disabled = true;
  setText("#cookiesTestStatus", "Membaca session browser secara lokal...");
  pushLog(`[auth] session_update=start source=browser browser=${browser}`);
  toast("Memperbarui YouTube Session dari browser...");
  try {
    const result = await window.cliper.updateYouTubeSession({ browser, url });
    if (!result?.ok) {
      const reason = result?.reason || "Session browser tidak dapat diperbarui.";
      state.cookiesInfo = result?.session?.present
        ? normalizeCookiesInfo({ cookies_path: result.session.path, cookies_meta: result.session })
        : state.cookiesInfo;
      renderCookiesManager();
      pushLog(`[auth] session_update=failed class=${result?.session?.errorClass || "UNKNOWN"}`);
      toast(`${reason} Gunakan Import File sebagai cadangan.`, { error: true, duration: 12000 });
      return;
    }
    state.cookiesPath = result.session.path;
    state.cookiesInfo = normalizeCookiesInfo({
      cookies_path: result.session.path,
      cookies_meta: result.session
    });
    await saveConfig({ silent: true });
    renderCookiesManager();
    pushLog(`[auth] session_update=success source=browser browser=${browser}`);
    toast("YouTube Session berhasil diperbarui dan akan dipakai otomatis.");
    await resumePendingSessionJob();
  } catch (error) {
    pushLog(`[auth] session_update=failed class=BROWSER_SESSION_UNAVAILABLE`);
    toast(error?.message || "Pembaruan session browser gagal.", { error: true, duration: 12000 });
  } finally {
    if (button) button.disabled = false;
  }
}

async function testCookies() {
  if (!state.cookiesPath) {
    toast("Import YouTube Session dulu");
    setSettingsTab("cookies");
    return;
  }
  const youtubeUrl = $("#youtubeUrl")?.value.trim() || "";
  if (!window.cliper?.testCookies) {
    toast("Test cookies tersedia di .exe");
    return;
  }
  toast("Memeriksa YouTube Session...");
  setText("#cookiesTestStatus", "Memeriksa session...");
  const result = await window.cliper.testCookies({ cookiesPath: state.cookiesPath, url: youtubeUrl });
  const data = result.result || {};
  const now = data.testedAt || new Date().toISOString();
  if (result.type === "error" || !data.testOk) {
    const status = data.status || data.reason || result.message || "Cookies invalid";
    state.cookiesInfo = {
      ...(state.cookiesInfo || {}),
      lastTest: now,
      testStatus: status,
      status,
      testUrl: youtubeUrl,
      state: data.session?.state || "SESSION_ERROR",
      errorClass: data.errorClass || "UNKNOWN",
      reason: status
    };
    await saveConfig({ silent: true });
    pushLog(`[cookies] test gagal: ${status}`);
    toast(status);
    return;
  }
  state.cookiesInfo = normalizeCookiesInfo({
    cookies_path: state.cookiesPath,
    cookies_meta: {
      ...(state.cookiesInfo || {}),
      ...(data.session || {}),
      state: data.session?.state || "SESSION_VALID",
      lastChecked: now,
      reason: null
    }
  });
  await saveConfig({ silent: true });
  pushLog(`[auth] YouTube Session valid; pemeriksaan metadata=${data.lastTestVideo ? "ok" : "unknown"}`);
  toast("YouTube Session valid");
  await resumePendingSessionJob();
}

async function removeCookies() {
  if (window.cliper?.removeYouTubeSession) {
    await window.cliper.removeYouTubeSession();
  }
  state.cookiesPath = "";
  state.cookiesInfo = null;
  state.pendingSessionResume = null;
  await saveConfig({ silent: true });
  renderCookiesManager();
  toast("YouTube Session lokal dihapus");
}

async function detectGpu() {
  setText("#detectedGpu", "Detecting GPU...");
  await scanSubtitles();
  const hardware = refreshHardwareStatus(state.dependencies);
  toast(hardware.active.includes("dipilih") ? "Encoder perangkat siap" : "GPU/runtime selesai dicek");
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$(".settings-tab").forEach((button) => button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab)));

  $("#youtubeUrl").addEventListener("input", (event) => {
    setSourceMode("youtube");
    resetSourceMetadata(event.target.value.trim());
    const clean = event.target.value.replace(/^https?:\/\//, "");
    $("#previewUrl").textContent = clean || "Masukkan link YouTube";
    scheduleMetadataFetch();
  });
  $("#pasteUrlButton").addEventListener("click", async () => {
    let text = "";
    try {
      text = window.cliper?.readClipboard ? await window.cliper.readClipboard() : await navigator.clipboard.readText();
    } catch {
      toast("Clipboard tidak bisa dibaca");
      return;
    }
    if (!text.trim()) {
      toast("Clipboard kosong");
      return;
    }
    $("#youtubeUrl").value = text.trim();
    setSourceMode("youtube");
    resetSourceMetadata(text.trim());
    $("#previewUrl").textContent = text.trim();
    scheduleMetadataFetch();
    toast("URL ditempel");
  });

  function setRequestedClipCount(count) {
    const nextCount = normalizeRequestedClipCount(count);
    syncClipTargetControls(nextCount);
    updateCounters();
    renderPipelinePreview();
  }

  function updateGenerateButtonLabel(count) {
    const num = normalizeRequestedClipCount(count || $("#clipCount")?.value || 4);
    const label = num === 1 ? "Generate 1 Clip" : `Generate ${num} Clips`;
    const span = $("#findMomentsLabel");
    if (span) {
      span.textContent = label;
    }
  }

  $("#clipCount")?.addEventListener("input", (event) => {
    const val = Number(event.target.value);
    if (Number.isFinite(val) && val >= 1 && val <= 10) {
      setRequestedClipCount(val);
    }
  });
  $("#clipCount")?.addEventListener("change", (event) => {
    const val = Math.max(1, Math.min(10, Math.round(Number(event.target.value) || 4)));
    setRequestedClipCount(val);
  });
  $("#clipCountDecrement")?.addEventListener("click", () => {
    const cur = Math.max(1, Math.min(10, Number($("#clipCount")?.value || 4)));
    if (cur > 1) setRequestedClipCount(cur - 1);
  });
  $("#clipCountIncrement")?.addEventListener("click", () => {
    const cur = Math.max(1, Math.min(10, Number($("#clipCount")?.value || 4)));
    if (cur < 10) setRequestedClipCount(cur + 1);
  });
  $$(".preset-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const count = Number(btn.dataset.presetCount);
      if (count) setRequestedClipCount(count);
    });
  });

  $("#clipCount")?.addEventListener("input", updateCounters);
  $("#clipCount")?.addEventListener("input", renderPipelinePreview);
  ["aiHighlightToggle", "aiHookToggle", "aiCaptionToggle", "aiTitleToggle"].forEach((id) => {
    const node = $(`#${id}`);
    if (node) {
      node.addEventListener("change", () => {
        renderProviders();
        renderPipelinePreview();
        saveConfig({ silent: true });
      });
    }
  });
  $("#captionStyle").addEventListener("change", () => {
    markSubtitlePreset("");
    updateCounters();
    updateSubtitlePreview();
  });
  $("#outputQualityProfile")?.addEventListener("change", (event) => {
    applyOutputQualityPreset(event.target.value);
    saveConfig({ silent: true });
  });
  $("#applyReferenceOutputPreset")?.addEventListener("click", () => {
    applyOutputQualityPreset("capcut_opus_2k");
    saveConfig({ silent: true });
  });
  [
    "smartCropToggle",
    "faceTrackToggle",
    "dynamicZoomToggle",
    "autoCutToggle",
    "audioEnhanceToggle",
    "autoVideoEnhancementToggle",
    "subtitleBurnToggle",
    "hookOpeningToggle",
    "hookDuration",
    "hookLayout",
    "ttsHookToggle",
    "watermarkEnabled",
    "watermarkInOutput",
    "gpuToggle",
    "formatProfile",
    "resolutionProfile",
    "fpsProfile",
    "crfProfile",
    "smartPublishingPlannerToggle",
    "publishingYouTubeToggle",
    "publishingInstagramToggle",
    "publishingTikTokToggle",
    "publishingTimezone",
    "publishingPostsPerDay",
    "publishingMinimumGapHours"
  ].forEach((id) => {
    const node = $(`#${id}`);
    if (node) node.addEventListener("change", () => {
      syncRendererSettingDependencies();
      renderPipelinePreview();
      if (id === "gpuToggle") refreshHardwareStatus();
      saveConfig({ silent: true });
      if (id === "formatProfile" || id === "resolutionProfile") {
        updateBrandPreview();
        updateSubtitlePreview();
      }
    });
  });
  $("#selectionMode")?.addEventListener("change", () => updateTimelinePreview());
  ["rangeStart", "rangeEnd"].forEach((id) => {
    const node = $(`#${id}`);
    if (!node) return;
    node.addEventListener("input", () => updateTimelinePreview({ normalizeInputs: false }));
    node.addEventListener("change", () => updateTimelinePreview());
    node.addEventListener("blur", () => updateTimelinePreview());
  });
  $("#multipleRanges")?.addEventListener("input", () => updateTimelinePreview({ normalizeInputs: false }));
  $("#multipleRanges")?.addEventListener("change", () => updateTimelinePreview());
  $("#analysisStartRange")?.addEventListener("input", () => updateAnalysisRangeFromSeekbar("start"));
  $("#analysisEndRange")?.addEventListener("input", () => updateAnalysisRangeFromSeekbar("end"));
  $$("[data-analysis-adjust]").forEach((button) => {
    button.addEventListener("click", () => adjustAnalysisRange(button.dataset.analysisAdjust));
  });
  ["logoScale", "logoOpacity", "logoRotation", "watermarkText", "watermarkOpacity", "watermarkTextSize", "watermarkTextColor", "watermarkTextStroke", "watermarkTextShadow", "watermarkFontFamily", "watermarkFontPath"].forEach((id) => {
    const node = $(`#${id}`);
    if (node) {
      node.addEventListener("input", updateBrandPreview);
      node.addEventListener("change", updateBrandPreview);
    }
  });
  ["subtitlePreviewInput", "subtitleWordHighlightToggle", "subtitleFontFamily", "subtitleFontSize", "subtitlePrimaryColor", "subtitleActiveColor", "subtitleStrokeColor", "subtitleShadow", "subtitleAnimation", "subtitleLetterSpacing"].forEach((id) => {
    const node = $(`#${id}`);
    if (node) {
      const update = () => {
        if (id !== "subtitlePreviewInput") markSubtitlePreset("");
        updateSubtitlePreview();
      };
      node.addEventListener("input", update);
      node.addEventListener("change", update);
    }
  });
  $$("[data-brand-preset]").forEach((button) => {
    button.addEventListener("click", () => setBrandPreset(button.dataset.brandPreset));
  });
  $$("[data-subtitle-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      applySubtitlePreset(button.dataset.subtitlePreset);
      saveConfig({ silent: true });
    });
  });
  bindPreviewDrag($("#brandPreviewLogo"), "logoX", "logoY");
  bindPreviewDrag($("#brandPreviewText"), "watermarkTextX", "watermarkTextY");
  bindPreviewDrag($("#subtitlePreviewText"), "subtitleX", "subtitleY", {
    frameSelector: "#subtitlePreviewFrame",
    update: updateSubtitlePreview,
  });
  window.addEventListener("resize", () => {
    updateBrandPreview();
    updateSubtitlePreview();
  });
  $("#chooseLogoAsset")?.addEventListener("click", async () => {
    if (!window.cliper?.selectLogoFile) {
      toast("Upload logo tersedia saat dibuka lewat .exe");
      return;
    }
    const filePath = await window.cliper.selectLogoFile();
    if (filePath) {
      setValue("#logoAssetPath", filePath);
      setValue("#watermarkEnabled", true);
      setValue("#watermarkInOutput", true);
      updateBrandPreview();
      await saveConfig({ silent: true });
      toast("Logo watermark dipilih");
    }
  });
  $("#chooseSubtitleFont")?.addEventListener("click", async () => {
    if (!window.cliper?.selectFontFile) {
      toast("Upload font tersedia saat dibuka lewat .exe");
      return;
    }
    const filePath = await window.cliper.selectFontFile();
    if (filePath) {
      setValue("#subtitleFontPath", filePath);
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.(ttf|otf)$/i, "");
      if (baseName) setValue("#subtitleFontFamily", baseName);
      updateSubtitlePreview();
      await saveConfig({ silent: true });
      toast("Font subtitle dipilih");
    }
  });
  $("#chooseWatermarkFont")?.addEventListener("click", async () => {
    if (!window.cliper?.selectFontFile) {
      toast("Upload font tersedia saat dibuka lewat .exe");
      return;
    }
    const filePath = await window.cliper.selectFontFile();
    if (filePath) {
      setValue("#watermarkFontPath", filePath);
      const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.(ttf|otf)$/i, "");
      if (baseName) setValue("#watermarkFontFamily", baseName);
      updateBrandPreview();
      await saveConfig({ silent: true });
      toast("Font watermark dipilih");
    }
  });

  $("#chooseCookieFile").addEventListener("click", async () => {
    setSettingsTab("cookies");
    await importCookies();
  });

  $("#cookieFile").addEventListener("change", (event) => {
    const file = event.target.files[0];
    const filePath = file?.path;
    if (filePath) {
      validateAndStoreCookies(filePath);
      return;
    }
    $("#cookieState").textContent = file ? `${file.name} siap dipakai` : "Belum dipilih";
    toast(file ? "Buka via .exe untuk validasi file cookies" : "cookies.txt kosong");
  });

  $("#scanSubtitles").addEventListener("click", scanSubtitles);
  $("#findMoments").addEventListener("click", findMoments);
  $("#momentSearch")?.addEventListener("input", (event) => {
    state.momentSearch = event.target.value;
    renderMoments();
  });
  $("#momentQualityFilter")?.addEventListener("change", (event) => {
    state.momentQualityFilter = event.target.value;
    renderMoments();
  });
  $("#momentThemeFilter")?.addEventListener("change", (event) => {
    state.momentThemeFilter = event.target.value;
    renderMoments();
  });
  $("#momentSort")?.addEventListener("change", (event) => {
    state.momentSort = event.target.value;
    renderMoments();
  });
  $("#processSelected")?.addEventListener("click", openProcessDialog);
  $("#bottomRenderSelectedBtn")?.addEventListener("click", openProcessDialog);

  $("#bottomSelectAllToggle")?.addEventListener("change", (event) => {
    const visible = filteredMoments();
    if (event.target.checked) {
      for (const item of visible) {
        state.selectedMoments.add(item.id);
        item.approved = true;
      }
    } else {
      for (const item of visible) {
        state.selectedMoments.delete(item.id);
        item.approved = false;
      }
    }
    renderMoments();
    updateCounters();
  });

  $("#refreshMomentsBtn")?.addEventListener("click", () => {
    renderMoments();
    renderMomentReview();
    toast("Daftar momen diperbarui");
  });

  $("#exportMomentsBtn")?.addEventListener("click", () => {
    const selected = selectedMoments();
    const list = selected.length ? selected : filteredMoments();
    const summary = list.map((m, i) => `#${i + 1} ${m.title} (${m.time}) - Kualitas ${momentQualityDisplay(m)}`).join("\n");
    if (navigator.clipboard) {
      navigator.clipboard.writeText(summary);
      toast("Daftar momen disalin ke clipboard!");
    } else {
      toast("Daftar momen siap diekspor");
    }
  });

  $("#viewModeGrid")?.addEventListener("click", () => {
    $("#viewModeGrid")?.classList.add("active");
    $("#viewModeList")?.classList.remove("active");
    $("#momentGrid")?.classList.remove("list-view");
  });

  $("#viewModeList")?.addEventListener("click", () => {
    $("#viewModeList")?.classList.add("active");
    $("#viewModeGrid")?.classList.remove("active");
    $("#momentGrid")?.classList.add("list-view");
  });

  document.querySelectorAll("[data-review-tab]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const tabKey = e.currentTarget.dataset.reviewTab;
      document.querySelectorAll("[data-review-tab]").forEach((b) => b.classList.remove("active"));
      e.currentTarget.classList.add("active");
      document.querySelectorAll(".review-tab-content").forEach((c) => (c.style.display = "none"));
      const targetContent = $(`#tab-review-${tabKey}`);
      if (targetContent) targetContent.style.display = "block";
    });
  });

  $("#closeReviewBtn")?.addEventListener("click", () => {
    const reviewPanel = $("#momentReviewPanel");
    if (reviewPanel) {
      reviewPanel.style.display = reviewPanel.style.display === "none" ? "flex" : "none";
    }
  });

  $("#resetReviewBoundary")?.addEventListener("click", () => {
    const moment = activeMoment();
    if (!moment) return;
    updateMomentTiming(moment.id, Number(moment.originalStart ?? moment.start), Number(moment.originalEnd ?? moment.end));
    renderMomentReview();
    renderMoments();
    toast("Boundary waktu direset ke awal");
  });

  $("#momentGrid").addEventListener("change", (event) => {
    const id = Number(event.target.dataset.toggleMoment);
    if (!id) return;
    if (event.target.checked) {
      state.selectedMoments.add(id);
      const item = momentBank.find((moment) => moment.id === id);
      if (item) item.approved = true;
    } else {
      state.selectedMoments.delete(id);
    }
    renderMoments();
    updateProcessButtons();
  });
  $("#momentGrid").addEventListener("input", (event) => {
    const startId = Number(event.target.dataset.inlineStart || 0);
    const endId = Number(event.target.dataset.inlineEnd || 0);
    if (startId) {
      const moment = momentBank.find((item) => item.id === startId);
      if (!moment) return;
      updateMomentTiming(startId, Number(event.target.value) / 10, moment.end);
      renderMoments();
      return;
    }
    if (endId) {
      const moment = momentBank.find((item) => item.id === endId);
      if (!moment) return;
      updateMomentTiming(endId, moment.start, Number(event.target.value) / 10, { seek: false });
      renderMoments();
    }
  });
  $("#momentGrid").addEventListener("click", (event) => {
    const selectBtn = event.target.closest("[data-toggle-moment-btn]");
    if (selectBtn) {
      event.preventDefault();
      event.stopPropagation();
      const id = Number(selectBtn.dataset.toggleMomentBtn || 0);
      if (!id) return;
      const item = momentBank.find((moment) => moment.id === id);
      if (state.selectedMoments.has(id)) {
        state.selectedMoments.delete(id);
        if (item) item.approved = false;
      } else {
        state.selectedMoments.add(id);
        if (item) item.approved = true;
      }
      renderMoments();
      updateProcessButtons();
      return;
    }
    const previewBtn = event.target.closest("[data-preview-moment]");
    if (previewBtn) {
      event.preventDefault();
      event.stopPropagation();
      const id = Number(previewBtn.dataset.previewMoment || 0);
      if (!id) return;
      state.activeMomentId = id;
      renderMoments();
      renderMomentReview();
      return;
    }
    const selectControl = event.target.closest("[data-toggle-moment], .moment-select");
    if (selectControl) {
      event.preventDefault();
      event.stopPropagation();
      const input = selectControl.matches("[data-toggle-moment]")
        ? selectControl
        : selectControl.querySelector("[data-toggle-moment]");
      const id = Number(input?.dataset.toggleMoment || 0);
      if (!id) return;
      const item = momentBank.find((moment) => moment.id === id);
      if (state.selectedMoments.has(id)) {
        state.selectedMoments.delete(id);
        if (item) item.approved = false;
      } else {
        state.selectedMoments.add(id);
        if (item) item.approved = true;
      }
      renderMoments();
      updateProcessButtons();
      return;
    }
    const rowButton = event.target.closest("[data-moment-row]");
    const playButton = event.target.closest("[data-play-moment]");
    const acceptButton = event.target.closest("[data-accept-moment]");
    const rejectButton = event.target.closest("[data-reject-moment]");
    const regenerateButton = event.target.closest("[data-regenerate-moment]");
    const inlineAdjustStart = event.target.closest("[data-inline-adjust-start]");
    const inlineAdjustEnd = event.target.closest("[data-inline-adjust-end]");
    const inlineBetterStart = event.target.closest("[data-inline-better-start]");
    const inlineBetterEnd = event.target.closest("[data-inline-better-end]");
    const id = Number(
      rowButton?.dataset.momentRow ||
      playButton?.dataset.playMoment ||
      acceptButton?.dataset.acceptMoment ||
      rejectButton?.dataset.rejectMoment ||
      regenerateButton?.dataset.regenerateMoment ||
      inlineAdjustStart?.dataset.inlineAdjustStart ||
      inlineAdjustEnd?.dataset.inlineAdjustEnd ||
      inlineBetterStart?.dataset.inlineBetterStart ||
      inlineBetterEnd?.dataset.inlineBetterEnd ||
      0
    );
    if (!id) return;
    if (rowButton) {
      state.activeMomentId = id;
      renderMoments();
      renderMomentReview();
    }
    if (inlineAdjustStart) {
      const moment = momentBank.find((item) => item.id === id);
      if (!moment) return;
      updateMomentTiming(id, moment.start + Number(inlineAdjustStart.dataset.delta || 0), moment.end);
      renderMoments();
      return;
    }
    if (inlineAdjustEnd) {
      const moment = momentBank.find((item) => item.id === id);
      if (!moment) return;
      updateMomentTiming(id, moment.start, moment.end + Number(inlineAdjustEnd.dataset.delta || 0), { seek: false });
      renderMoments();
      return;
    }
    if (inlineBetterStart) {
      setActiveMoment(id);
      suggestBetterBoundary("start");
      renderMoments();
      return;
    }
    if (inlineBetterEnd) {
      setActiveMoment(id);
      suggestBetterBoundary("end");
      renderMoments();
      return;
    }
    if (playButton) {
      setActiveMoment(id);
      const video = $(`[data-inline-video="${id}"]`) || $("#momentPreviewVideo");
      if (video) {
        video.currentTime = activeMoment()?.start || 0;
        video.play().catch(() => toast("Preview video belum siap"));
      }
      return;
    }
    if (acceptButton) {
      const item = momentBank.find((moment) => moment.id === id);
      state.selectedMoments.add(id);
      if (item) item.approved = true;
      renderMoments();
      updateProcessButtons();
      toast("Clip accepted untuk render");
      return;
    }
    if (rejectButton) {
      const item = momentBank.find((moment) => moment.id === id);
      if (item) item.rejected = true;
      state.selectedMoments.delete(id);
      if (state.activeMomentId === id) state.activeMomentId = activeMoment()?.id || null;
      renderMomentReview();
      renderMoments();
      updateProcessButtons();
      toast("Moment ditolak");
      return;
    }
    if (regenerateButton) {
      setActiveMoment(id);
      regenerateActiveMoment();
      return;
    }
    if (rowButton && !event.target.closest("input, button, a, select, textarea")) {
      setActiveMoment(id);
    }
  });

  $("#momentPreviewVideo")?.addEventListener("timeupdate", () => {
    const moment = activeMoment();
    const video = $("#momentPreviewVideo");
    if (!moment || !video) return;
    // keep subtitle in sync on time updates
    updateReviewSubtitle();
    if (video.currentTime > moment.end) {
      video.pause();
      video.currentTime = moment.end;
    }
  });
  $("#momentPreviewVideo")?.addEventListener("play", () => startSubtitleSync());
  $("#momentPreviewVideo")?.addEventListener("pause", () => cancelSubtitleSync());
  $("#momentPreviewVideo")?.addEventListener("seeked", () => updateReviewSubtitle());
  $("#momentPreviewVideo")?.addEventListener("loadedmetadata", renderMomentReview);
  $("#reviewPlayPause")?.addEventListener("click", () => {
    const video = $("#momentPreviewVideo");
    if (!video) return;
    if (video.paused) {
      const moment = activeMoment();
      if (moment && (video.currentTime < moment.start || video.currentTime >= moment.end)) {
        video.currentTime = moment.start;
      }
      video.play().catch(() => toast("Preview video belum siap"));
    } else {
      video.pause();
    }
  });
  $("#reviewStartRange")?.addEventListener("input", () => {
    const moment = activeMoment();
    if (!moment) return;
    updateMomentTiming(moment.id, Number($("#reviewStartRange").value) / 10, moment.end);
    renderMoments();
  });
  $("#reviewEndRange")?.addEventListener("input", () => {
    const moment = activeMoment();
    if (!moment) return;
    updateMomentTiming(moment.id, moment.start, Number($("#reviewEndRange").value) / 10, { seek: false });
    renderMoments();
  });
  $("#reviewStartInput")?.addEventListener("change", () => {
    const moment = activeMoment();
    if (!moment) return;
    updateMomentTiming(moment.id, parseTimeInput($("#reviewStartInput").value, moment.start), moment.end);
    renderMoments();
  });
  $("#reviewEndInput")?.addEventListener("change", () => {
    const moment = activeMoment();
    if (!moment) return;
    updateMomentTiming(moment.id, moment.start, parseTimeInput($("#reviewEndInput").value, moment.end), { seek: false });
    renderMoments();
  });
  $$("[data-adjust-start]").forEach((button) => {
    button.addEventListener("click", () => {
      const moment = activeMoment();
      if (!moment) return;
      updateMomentTiming(moment.id, moment.start + Number(button.dataset.adjustStart), moment.end);
      renderMoments();
    });
  });
  $$("[data-adjust-end]").forEach((button) => {
    button.addEventListener("click", () => {
      const moment = activeMoment();
      if (!moment) return;
      updateMomentTiming(moment.id, moment.start, moment.end + Number(button.dataset.adjustEnd), { seek: false });
      renderMoments();
    });
  });
  $("#suggestBetterStart")?.addEventListener("click", () => {
    suggestBetterBoundary("start");
    renderMoments();
  });
  $("#suggestBetterEnding")?.addEventListener("click", () => {
    suggestBetterBoundary("end");
    renderMoments();
  });
  $("#regenerateMoment")?.addEventListener("click", regenerateActiveMoment);
  $("#rejectMoment")?.addEventListener("click", () => {
    const moment = activeMoment();
    if (!moment) return;
    moment.rejected = true;
    state.selectedMoments.delete(moment.id);
    state.activeMomentId = activeMoment()?.id || null;
    renderMomentReview();
    renderMoments();
    updateProcessButtons();
  });
  $("#acceptMoment")?.addEventListener("click", () => {
    const moment = activeMoment();
    if (!moment) return;
    state.selectedMoments.add(moment.id);
    moment.approved = true;
    renderMoments();
    updateProcessButtons();
    toast("Clip accepted untuk render");
  });
  document.addEventListener("keydown", (event) => {
    if (state.view !== "moments") return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
    const video = $("#momentPreviewVideo");
    if (!video) return;
    if (event.code === "Space") {
      event.preventDefault();
      $("#reviewPlayPause")?.click();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - (event.shiftKey ? 5 : 1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      video.currentTime = Math.min(videoDurationLimit(), video.currentTime + (event.shiftKey ? 5 : 1));
    }
  });

  $("#sessionList").addEventListener("click", (event) => {
    const sessionButton = event.target.closest("[data-open-session]");
    if (sessionButton) {
      openSessionFolder(sessionButton.dataset.openSession);
      return;
    }
    const publishingButton = event.target.closest("[data-open-publishing]");
    if (publishingButton) {
      const session = sessions[Number(publishingButton.dataset.openPublishing)];
      const planPath = session?.publishingPlanPath;
      if (!planPath || !window.cliper?.openFolder) {
        toast("Publishing Plan belum tersedia");
        return;
      }
      window.cliper.openFolder(planPath).then((result) => {
        if (!result?.ok) toast(result?.message || "Publishing Plan tidak bisa dibuka");
      });
      return;
    }
    const copyButton = event.target.closest("[data-copy-publishing]");
    if (copyButton) copyPublishingTitles(copyButton.dataset.copyPublishing);
  });

  $("#selectAllButton").addEventListener("click", () => {
    const visibleMoments = filteredMoments();
    const allSelected = visibleMoments.length > 0 && visibleMoments.every((item) => state.selectedMoments.has(item.id));
    for (const item of visibleMoments) {
      if (allSelected) {
        state.selectedMoments.delete(item.id);
      } else {
        state.selectedMoments.add(item.id);
        item.approved = true;
      }
    }
    renderMoments();
    updateProcessButtons();
  });

  $("#cancelJob").addEventListener("click", async () => {
    state.cancelRequested = true;
    if (window.cliper) {
      await window.cliper.cancel();
      showProcessingCancelled(state.jobMode);
      pushLog("[cancelled] worker dibatalkan");
      toast("Worker dibatalkan");
      return;
    }
    if (!state.processingTimer) return;
    clearInterval(state.processingTimer);
    state.processingTimer = null;
    showProcessingCancelled(state.jobMode);
    state.logLines.push("[cancelled] render dibatalkan user");
    renderLogs();
    toast("Render dibatalkan");
  });

  $("#renderErrorClose").addEventListener("click", () => {
    clearProcessingError();
  });

  $("#resetButton").addEventListener("click", () => {
    setSourceMode("youtube");
    $("#youtubeUrl").value = "";
    $("#previewUrl").textContent = "Masukkan link YouTube";
    $("#previewTitle").textContent = "Belum ada video";
    $("#previewScore").textContent = "-";
    state.previewImageUrl = "";
    state.videoDuration = 0;
    metadataUrl = "";
    metadataPendingUrl = "";
    setValue("#selectionMode", "full");
    setValue("#rangeStart", "00:00");
    setValue("#rangeEnd", "");
    setValue("#multipleRanges", "");
    $("#clipCount").value = 0;
    state.lastAnalysis = null;
    state.lastTranscript = [];
    state.activeMomentId = null;
    state.selectedMoments = new Set();
    momentBank = [];
    updateCounters();
    renderMoments();
    drawPreview();
    updateTimelinePreview();
    toast("Form direset");
  });

  $("#refreshPreview").addEventListener("click", () => {
    const url = $("#youtubeUrl").value.trim();
    if (url) {
      scheduleMetadataFetch(true);
      toast("Metadata diperbarui");
    } else {
      drawPreview();
    }
  });
  $("#newSessionButton").addEventListener("click", () => setView("studio"));
  $("#saveConfig").addEventListener("click", () => saveConfig());
  $("#chooseOutputFolder").addEventListener("click", async () => {
    if (!window.cliper) {
      toast("Folder picker tersedia di .exe");
      return;
    }
    const folder = await window.cliper.selectOutputFolder();
    if (folder) {
      $("#outputFolder").value = folder;
      await saveConfig({ silent: true });
      toast("Folder output dipilih");
    }
  });
  $("#checkDependencyButton").addEventListener("click", scanSubtitles);
  $("#installRuntimeButton").addEventListener("click", async () => {
    const button = $("#installRuntimeButton");
    const status = $("#runtimeInstallStatus");
    if (!window.cliper?.installRuntime) {
      toast("Installer runtime hanya tersedia di aplikasi desktop.");
      return;
    }
    button.disabled = true;
    status.classList.remove("error");
    status.classList.add("running");
    status.textContent = "Menyiapkan komponen yang diperlukan untuk mengunduh dan merender video. Proses ini dapat memerlukan beberapa menit.";
    pushLog("[runtime] instalasi otomatis dimulai");
    const result = await window.cliper.installRuntime();
    button.disabled = false;
    status.classList.remove("running");
    status.classList.toggle("error", !result?.ok);
    status.textContent = result?.status || "Installer runtime selesai.";
    pushLog(`[runtime] ${status.textContent}`);
    if (result?.ok) {
      await scanSubtitles();
      toast("Sistem siap digunakan");
    } else {
      toast(result?.status || "Instalasi runtime gagal");
    }
  });
  $("#detectGpuButton").addEventListener("click", detectGpu);
  applyProviderDefaults(true);
  $("#apiKey").addEventListener("input", () => {
    state.cloudConnectionOk = false;
    state.cloudRouterReady = false;
    state.cloudConnectionKeyFingerprint = "";
    renderProviders();
    setProviderStatus($("#apiKey").value.trim() ? "API key tersimpan · test connection" : "Cliper AI Cloud belum terhubung", false);
    renderCloudConnectionStatus(Boolean($("#apiKey").value.trim()));
  });
  $("#toggleApiKeyVisibility").addEventListener("click", () => {
    const input = $("#apiKey");
    const button = $("#toggleApiKeyVisibility");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.classList.toggle("active", show);
    button.title = show ? "Sembunyikan API key" : "Tampilkan API key";
  });
  $("#highlightModel").addEventListener("input", renderProviders);
  initializeProviderControls();
  $("#importCookiesButton").addEventListener("click", updateYouTubeSession);
  $("#replaceCookiesButton").addEventListener("click", importCookies);
  $("#testCookiesButton").addEventListener("click", testCookies);
  $("#removeCookiesButton").addEventListener("click", removeCookies);
  $("#openExtensionGuide").addEventListener("click", () => {
    const url = "https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies";
    if (window.cliper?.openExternal) {
      window.cliper.openExternal(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  });
  $("#openRuntimeGuide").addEventListener("click", async () => {
    if (window.cliper?.openUserGuide) {
      const result = await window.cliper.openUserGuide();
      if (result?.ok) {
        pushLog(`[guide] panduan pengguna dibuka: ${result.path}`);
        return;
      }
      pushLog(`[guide] ${result?.message || "Panduan lokal tidak dapat dibuka"}`);
    }
    const url = "https://github.com/yt-dlp/yt-dlp/wiki/Installation";
    if (window.cliper?.openExternal) window.cliper.openExternal(url);
    else window.open(url, "_blank", "noopener");
  });
  $("#cookiesDropZone").addEventListener("click", importCookies);
  $("#cookiesDropZone").addEventListener("dragover", (event) => {
    event.preventDefault();
    $("#cookiesDropZone").classList.add("dragging");
  });
  $("#cookiesDropZone").addEventListener("dragleave", () => $("#cookiesDropZone").classList.remove("dragging"));
  $("#cookiesDropZone").addEventListener("drop", async (event) => {
    event.preventDefault();
    $("#cookiesDropZone").classList.remove("dragging");
    const file = event.dataTransfer.files?.[0];
    if (!file?.path) {
      toast("Drag & drop path tersedia di .exe");
      return;
    }
    await validateAndStoreCookies(file.path);
  });
  $("#testApiButton").addEventListener("click", async () => {
    const result = await testProvider({ silent: false });
    if (result?.ok) {
      state.apiLastTestedAt = new Date().toISOString();
      state.apiLastLatencyMs = result.latencyMs || state.apiLastLatencyMs;
      state.apiLastResponse = result.response || "";
      await saveConfig({ silent: true });
    }
  });

  // General Settings Dashboard Bindings
  $("#apiKeyGeneral")?.addEventListener("input", (e) => {
    const val = e.target.value;
    if ($("#apiKey")) $("#apiKey").value = val;
    saveConfig({ silent: true });
  });
  $("#toggleApiKeyVisibilityGeneral")?.addEventListener("click", () => {
    const input = $("#apiKeyGeneral");
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
  });
  $("#copyApiKeyGeneral")?.addEventListener("click", () => {
    const key = $("#apiKey")?.value || $("#apiKeyGeneral")?.value || "";
    if (key && navigator.clipboard) {
      navigator.clipboard.writeText(key);
      toast("API Key disalin ke clipboard");
    } else {
      toast("API Key kosong");
    }
  });
  $("#testApiButtonGeneral")?.addEventListener("click", () => {
    $("#testApiButton")?.click();
  });
  $("#generalBrowseFolderBtn")?.addEventListener("click", () => {
    $("#chooseOutputFolder")?.click();
  });
  $("#generalOpenPreviewBtn")?.addEventListener("click", () => {
    setView("studio");
  });
  $("#generalRefreshSessionBtn")?.addEventListener("click", () => {
    $("#testCookiesButton")?.click();
  });
  $("#generalImportCookiesBtn")?.addEventListener("click", () => {
    $("#replaceCookiesButton")?.click();
  });
  $("#generalClearCookiesBtn")?.addEventListener("click", () => {
    $("#removeCookiesButton")?.click();
  });
  $("#generalGpuToggle")?.addEventListener("change", (e) => {
    const gpuToggle = $("#gpuToggle");
    if (gpuToggle) {
      gpuToggle.checked = e.target.checked;
      gpuToggle.dispatchEvent(new Event("change"));
    }
  });
  $$(".dot-btn").forEach((dot) => {
    dot.addEventListener("click", () => {
      $$(".dot-btn").forEach((d) => d.classList.remove("active"));
      dot.classList.add("active");
      const pos = dot.dataset.pos;
      const brandBtn = $(`[data-brand-preset="${pos}"]`);
      if (brandBtn) brandBtn.click();
    });
  });
  $$(".sub-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".sub-preset-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const presetName = btn.textContent.trim().toLowerCase();
      const presetBtn = $(`[data-subtitle-preset="${presetName}"]`);
      if (presetBtn) presetBtn.click();
    });
  });

  if (window.cliper) {
    window.cliper.onRuntimeInstallEvent?.((event) => {
      const status = $("#runtimeInstallStatus");
      if (!status || !event?.message) return;
      status.textContent = event.message;
      status.classList.toggle("error", event.type === "error");
      status.classList.toggle("running", event.type === "output");
      pushLog(`[runtime] ${event.message}`);
    });
    window.cliper.onWorkerEvent((event) => {
      if (event.type === "progress") {
        state.progress = Number(event.progress || state.progress || 0);
        $("#progressBar").style.width = `${state.progress}%`;
        if (state.progress >= 100 || String(event.stage || "").toLowerCase() === "done") {
          stepDefinitions().forEach((step) => {
            if (state.renderStepStatus[step.id] !== "error") state.renderStepStatus[step.id] = "done";
          });
        } else {
          setActiveStep(event.stage || event.message, "active");
        }
        pushLog(`[${String(Math.round(state.progress)).padStart(3, "0")}%] ${event.message || event.stage}`);
        updateRenderStats(event);
        renderSteps();
      } else if (event.type === "log") {
        pushLog(event.message);
      } else if (event.type === "clip_done") {
        pushLog(`[done] Clip ${event.clipIndex}/${event.totalClips}: ${event.title || "selesai"}`);
        setActiveStep("watermark", "done");
        renderSteps();
      } else if (event.type === "clip_error") {
        state.renderErrors.push(event);
        setActiveStep(event.stage || "portrait", "error");
        pushLog(`[error] Clip ${event.clipIndex}/${event.totalClips}: ${event.message}`);
        renderSteps();
      } else if (event.type === "error") {
        if (state.jobMode === "render") {
          setActiveStep($("#renderStageStat")?.textContent || "portrait", "error");
          renderSteps();
        }
        pushLog(`[error] ${event.message}`);
      }
    });
  }
}

async function init() {
  await loadSettingsContract();
  await loadConfig();
  bindEvents();
  clearProcessingError();
  renderMoments();
  renderSteps();
  renderLogs();
  renderSessions();
  renderProviders();
  renderCookiesManager();
  renderRuntimeList();
  renderPipelinePreview();
  setText("#appVersion", appVersion ? `v${appVersion}` : "v-");
  updateCounters();
  drawPreview();
}

init();
