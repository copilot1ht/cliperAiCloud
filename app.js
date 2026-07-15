const state = {
  view: "studio",
  selectedMoments: new Set(),
  progress: 0,
  processingTimer: null,
  scanCount: 0,
  cookiesPath: "",
  cookiesInfo: null,
  config: {},
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
  momentQualityFilter: "all",
  momentSort: "score",
  apiLastTestedAt: "",
  apiLastLatencyMs: 0,
  apiLastResponse: "",
  aiUsageToday: { date: "", inputTokens: 0, outputTokens: 0, estimatedCostRp: 0 },
  logLines: [
    "[ready] Menunggu link YouTube"
  ]
};

const APP_VERSION = "1.10.0-beta.3";

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

const aiProviderDefaults = {
  cloud: { label: "Cliper Cloud Gateway", baseUrl: "https://api.cliper.cloud/v1", model: "auto", requiresKey: true }
};

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
  return { ...PRODUCTION_RENDER_PRESET };
}

function getOutputQualityPreset(profile) {
  return OUTPUT_QUALITY_PRESETS[profile] || OUTPUT_QUALITY_PRESETS.balanced;
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove("show"), 2200);
}

function setView(view) {
  state.view = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `view-${view}`));
}

function selectedMoments() {
  return momentBank.filter((item) => !item.rejected && item.renderEligible !== false && state.selectedMoments.has(item.id));
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
  return Math.max(1, Number(state.lastAnalysis?.video?.duration || $("#momentPreviewVideo")?.duration || 0) || 1);
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
    setText("#reviewScore", "Score -");
    setText("#reviewDuration", "Duration -");
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
  setText("#reviewClipTitle", `Clip ${moment.id}: ${moment.title}`);
  setText("#reviewScore", `Score ${moment.score}/100`);
  setText("#reviewReason", moment.reason || "Kandidat dipilih berdasarkan hook, story, payoff, dan retention evidence.");
  setText("#reviewTranscript", moment.transcript || "Transcript tidak tersedia.");
  const evidence = $("#reviewEvidence");
  if (evidence) {
    const metrics = moment.metrics || {};
    const items = [
      ["Hook", metrics.hook],
      ["Story", metrics.story_complete || metrics.flow],
      ["Payoff", metrics.payoff],
      ["Retention", metrics.retention_predictor],
      ["Emotion", metrics.emotion],
      ["Conflict", metrics.conflict],
    ];
    evidence.innerHTML = items.map(([label, value]) => `<span><small>${label}</small><strong>${Number(value || 0) || "-"}</strong></span>`).join("");
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
    reason: "Alternatif lokal dari area dekat moment sebelumnya.",
    score: Math.max(60, Number(moment.score || 70) - 4),
    edited: true
  }, momentBank.length, state.lastAnalysis?.video || {});
  moment.rejected = true;
  momentBank.push(replacement);
  state.selectedMoments.delete(moment.id);
  state.selectedMoments.add(replacement.id);
  state.activeMomentId = replacement.id;
  renderMomentReview();
  renderMoments();
  toast("Alternatif moment dibuat");
}

function updateCounters() {
  const count = selectedMoments().length;
  $("#clipCounter").textContent = `${count} clip dipilih`;
  $("#previewDuration").textContent = state.lastAnalysis
    ? `${count} clip auto selected`
    : "Belum dianalisa";
  $("#captionMetric").textContent = state.lastAnalysis ? ($("#captionStyle") ? $("#captionStyle").value : "Caption aktif") : "Belum diproses";
  updateProcessButtons();
}

function aiFeatureConfig() {
  return {
    highlight: Boolean($("#aiHighlightToggle")?.checked),
    hook: Boolean($("#aiHookToggle")?.checked),
    caption: Boolean($("#aiCaptionToggle")?.checked),
    title: Boolean($("#aiTitleToggle")?.checked),
    tts: Boolean($("#aiTtsToggle")?.checked)
  };
}

function momentQuality(item) {
  if (item.score >= 85) return { key: "excellent", label: "Excellent" };
  if (item.score >= 70) return { key: "good", label: "Good" };
  return { key: "review", label: "Review" };
}

function filteredMoments() {
  const query = String(state.momentSearch || "").trim().toLowerCase();
  const qualityFilter = state.momentQualityFilter || "all";
  const items = momentBank.filter((item) => {
    if (item.rejected) return false;
    if (qualityFilter === "selected" && !state.selectedMoments.has(item.id)) return false;
    if (!["all", "selected"].includes(qualityFilter) && momentQuality(item).key !== qualityFilter) return false;
    if (!query) return true;
    const haystack = `${item.title || ""} ${item.hook || ""} ${item.transcript || ""} ${item.topic || ""} ${item.category || ""}`.toLowerCase();
    return haystack.includes(query);
  });
  const metric = (item, key, fallback = 0) => Number(item.metrics?.[key] ?? fallback);
  return items.sort((left, right) => {
    if (state.momentSort === "hook") return metric(right, "hook") - metric(left, "hook");
    if (state.momentSort === "story") return metric(right, "story_complete", metric(right, "flow")) - metric(left, "story_complete", metric(left, "flow"));
    if (state.momentSort === "shortest") return left.durationSeconds - right.durationSeconds;
    if (state.momentSort === "timeline") return left.start - right.start;
    return right.score - left.score;
  });
}

function renderMoments() {
  const grid = $("#momentGrid");
  const visibleMoments = filteredMoments();
  setText("#momentResultCount", `${visibleMoments.length} kandidat`);
  if (visibleMoments.length === 0) {
    const analysisFinished = Boolean(state.lastAnalysis);
    grid.innerHTML = `
      <div class="empty-state wide">
        <strong>${analysisFinished ? "Belum ada moment yang lolos validasi." : "Masukkan link YouTube untuk menganalisa moment terbaik."}</strong>
        <span>${analysisFinished ? "Kandidat tidak disembunyikan lagi. Jalankan analisa ulang untuk memuat kandidat Optional dengan score asli." : "Moment AI muncul setelah metadata, transcript, story, dan scoring selesai dianalisis."}</span>
      </div>
    `;
    updateCounters();
    return;
  }
  grid.innerHTML = visibleMoments
    .map((item) => {
      const checked = state.selectedMoments.has(item.id);
      const active = state.activeMomentId === item.id;
      const disabled = item.renderEligible === false;
      const quality = momentQuality(item);
      const thumbnail = item.previewThumbnail ? toFilePreviewSrc(item.previewThumbnail) : "";
      return `
        <article class="moment-card quality-${quality.key} ${checked ? "selected" : ""} ${active ? "active-review" : ""} ${disabled ? "low-quality" : ""}" data-moment-row="${item.id}" tabindex="0">
          <div class="moment-thumbnail">
            ${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" />` : ""}
            <span class="moment-source">${escapeHtml(item.type)}</span>
            <span class="moment-score"><strong>${item.score}</strong><em>${quality.label}</em></span>
            <span class="moment-time">${escapeHtml(item.time)}</span>
            <label class="moment-select" title="Pilih untuk render">
              <input type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} data-toggle-moment="${item.id}" />
              <span>✓</span>
            </label>
          </div>
          <div class="moment-body">
            <h3>${escapeHtml(item.title)}</h3>
            <p class="moment-hook">${escapeHtml(item.hook || item.titleSuggestion || "")}</p>
            ${item.metrics ? `
              <div class="moment-metrics">
                <span>Hook ${item.metrics.hook || "-"}</span>
                <span>Story ${item.metrics.story_complete || item.metrics.flow || "-"}</span>
                <span>Viral ${item.metrics.virality || item.metrics.trend || "-"}</span>
              </div>
            ` : ""}
            <div class="moment-card-footer">
              <span>${escapeHtml(item.category || "Insight")}</span>
              <span>${item.duration}</span>
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
  const score = Math.max(0, Math.min(100, Math.round(Number(item.score || 0))));
  const type = item.ai_selected ? (item.ai_source || "AI Provider") : (item.segment_type || item.type || "Local Heuristic");
  const title = item.titleSuggestion || item.title || `Moment ${index + 1}`;
  const metrics = item.metrics && typeof item.metrics === "object" ? item.metrics : null;
  return {
    ...item,
    id: item.id || index + 1,
    start,
    end,
    score,
    type,
    title,
    durationSeconds,
    duration: `${durationSeconds}s`,
    time: item.time || `${formatDuration(start)} - ${formatDuration(end)}`,
    previewThumbnail: item.preview_thumbnail_path || video.thumbnail || "",
    titleSuggestion: item.titleSuggestion || item.hook || title,
    reason: item.reason || "",
    category: item.category || item.segment_type || "Insight",
    speaker: item.speaker || item.speaker_label || "Speaker auto",
    sourcePath: item.source_path || item.sourcePath || video.source_path || "",
    sourceInfo: item.source_info || item.sourceInfo || null,
    transcriptSegments: Array.isArray(item.transcript_segments) ? item.transcript_segments : [],
    metrics,
    grade: item.grade || "",
    priority: item.priority || (score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "LOW" : "REJECT"),
    autoRender: item.auto_render === true && score >= 78,
    manualReview: item.manual_review_candidate === true,
    renderEligible: item.manual_review_candidate === true || (item.render_eligible !== false && score >= 65),
    lowQuality: item.low_quality === true || score < 65
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
  return {
    sourceMode: "youtube",
    url: $("#youtubeUrl").value.trim(),
    clipCount: Number($("#clipCount").value || 5),
    fullAutoMode: true,
    autoClipCount: true,
    autoRenderMinScore: 78,
    subtitleLang: $("#subtitleLang").value,
    minDuration: Number(fieldValue("minDuration", 30)),
    targetDuration: Number(fieldValue("targetDuration", 75)),
    maxDuration: Number(fieldValue("maxDuration", 180)),
    autoDuration: true,
    selectionMode: fieldValue("selectionMode", "full"),
    rangeStart: fieldValue("rangeStart", ""),
    rangeEnd: fieldValue("rangeEnd", ""),
    multipleRanges: fieldValue("multipleRanges", ""),
    scoreMode: $("#scoreMode").value,
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
    autoVideoEnhancement: true,
    gpuAcceleration: $("#gpuToggle")?.checked,
    activeEncoder: $("#activeEncoder")?.textContent,
    productionPreset,
    transformativeMode: false,
    introContext: false,
    editorialDisclaimer: true,
    noReuploadMode: true,
    smartCrop: true,
    dynamicZoom: productionPreset.dynamicZoom,
    addCaptions: productionPreset.addCaptions,
    burnSubtitle: productionPreset.burnSubtitle,
    autoCut: productionPreset.autoCut,
    addHook: productionPreset.addHook,
    addTtsHook: productionPreset.addTtsHook,
    hookDuration: $("#hookDuration")?.value,
    contextDuration: 1.8,
    faceTrack: productionPreset.faceTrack,
    audioEnhance: productionPreset.audioEnhance,
    autoVideoEnhancement: true,
    creditText: creditTextEnabled,
    sourceCreditText: `Source: ${sourceChannel}`,
    logoOverlay: logoOverlayEnabled,
    logoPath,
    logoX: percentField("logoX", 82),
    logoY: percentField("logoY", 8),
    logoScale: numberField("logoScale", 18),
    logoOpacity: numberField("logoOpacity", 90),
    logoRotation: numberField("logoRotation", 0),
    exportThumbnailPreview: productionPreset.exportThumbnailPreview,
    addWatermark: watermarkEnabled,
    watermarkText,
    watermarkOpacity: $("#watermarkOpacity")?.value,
    watermarkPosition: $("#watermarkPosition")?.value,
    watermarkTextX: percentField("watermarkTextX", 78),
    watermarkTextY: percentField("watermarkTextY", 16),
    watermarkTextSize: numberField("watermarkTextSize", 28),
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
    subtitleFontSize: numberField("subtitleFontSize", 60),
    subtitlePrimaryColor: fieldValue("subtitlePrimaryColor", "#ffffff"),
    subtitleActiveColor: fieldValue("subtitleActiveColor", "#19ff47"),
    subtitleStrokeColor: fieldValue("subtitleStrokeColor", "#000000"),
    subtitleShadow: numberField("subtitleShadow", 4),
    subtitleAnimation: fieldValue("subtitleAnimation", "Scale"),
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

function updateTimelinePreview() {
  const mode = fieldValue("selectionMode", "full");
  const badge = $("#timelineRangeBadge");
  const multipleField = $("#multipleRangesField");
  if (multipleField) multipleField.style.display = mode === "multiple" ? "grid" : "none";
  const duration = Math.max(0, Number(state.videoDuration || state.lastAnalysis?.video?.duration || 0));
  const maxValue = Math.max(100, Math.round((duration || 100) * 10));
  const startRange = $("#analysisStartRange");
  const endRange = $("#analysisEndRange");
  if (startRange) startRange.max = String(maxValue);
  if (endRange) endRange.max = String(maxValue);

  let start = parseTimeInput(fieldValue("rangeStart", "0"), 0);
  let end = parseTimeInput(fieldValue("rangeEnd", ""), duration || maxValue / 10);
  if (mode === "full") {
    start = 0;
    end = duration || maxValue / 10;
  } else {
    start = Math.max(0, Math.min(start, Math.max(0, (duration || maxValue / 10) - 1)));
    end = Math.max(start + 1, Math.min(end || duration || start + 1, duration || maxValue / 10));
  }
  if (startRange) startRange.value = String(Math.round(start * 10));
  if (endRange) endRange.value = String(Math.round(end * 10));
  setText("#analysisStartBadge", formatDuration(start));
  setText("#analysisEndBadge", mode === "full" && !duration ? "End" : formatDuration(end));

  if (!badge) return;
  if (mode === "range") {
    badge.textContent = `${formatDuration(start)} - ${formatDuration(end)}`;
  } else if (mode === "multiple") {
    const count = (fieldValue("multipleRanges", "").split(/\n|,/).map((item) => item.trim()).filter(Boolean)).length;
    badge.textContent = `${count || 0} range`;
  } else {
    badge.textContent = duration ? `Full video · ${formatDuration(duration)}` : "Full video";
  }
}

function updateAnalysisRangeFromSeekbar(changedEdge = "end") {
  const duration = Math.max(0, Number(state.videoDuration || state.lastAnalysis?.video?.duration || 0));
  const startRange = $("#analysisStartRange");
  const endRange = $("#analysisEndRange");
  if (!startRange || !endRange) return;
  const maxSeconds = duration || Math.max(Number(endRange.max || 100) / 10, 1);
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

function setBrandPreset(preset) {
  const positions = {
    "top-left": [16, 8, 18, 16, "Top left"],
    "top-center": [50, 8, 50, 16, "Top center"],
    "top-right": [84, 8, 78, 16, "Top right"],
    "middle-left": [16, 50, 18, 58, "Middle left"],
    "center": [50, 42, 50, 52, "Center"],
    "middle-right": [84, 50, 78, 58, "Middle right"],
    "bottom-left": [16, 84, 18, 92, "Bottom left"],
    "bottom-center": [50, 84, 50, 92, "Bottom center"],
    "bottom-right": [84, 84, 78, 92, "Bottom right"]
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
  const logo = $("#brandPreviewLogo");
  const text = $("#brandPreviewText");
  const logoPath = fieldValue("logoAssetPath", "");
  if (logo) {
    logo.src = toFilePreviewSrc(logoPath || "assets/icon-512.png");
    logo.style.left = `${percentField("logoX", 82)}%`;
    logo.style.top = `${percentField("logoY", 8)}%`;
    logo.style.width = `${Math.max(8, Math.min(60, numberField("logoScale", 18)))}%`;
    logo.style.opacity = `${Math.max(0.1, Math.min(1, numberField("logoOpacity", 90) / 100))}`;
    logo.style.transform = `translate(-50%, -50%) rotate(${numberField("logoRotation", 0)}deg)`;
  }
  if (text) {
    const value = fieldValue("watermarkText", "@cliperai") || "@cliperai";
    text.textContent = value;
    refreshWatermarkFontFace();
    text.style.left = `${percentField("watermarkTextX", 78)}%`;
    text.style.top = `${percentField("watermarkTextY", 16)}%`;
    text.style.fontFamily = `"${fieldValue("watermarkFontFamily", "Arial Black")}", Arial, sans-serif`;
    text.style.fontSize = `${Math.max(12, Math.min(72, numberField("watermarkTextSize", 28))) * 0.52}px`;
    text.style.color = fieldValue("watermarkTextColor", "#ffffff");
    text.style.opacity = `${Math.max(0.1, Math.min(1, numberField("watermarkOpacity", 68) / 100))}`;
    const shadow = numberField("watermarkTextShadow", 2);
    text.style.textShadow = shadow ? `0 ${shadow}px 0 ${fieldValue("watermarkTextStroke", "#000000")}, 0 0 ${shadow * 4}px rgba(0,0,0,.65)` : "none";
  }
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

function applySubtitlePreset(preset) {
  const presets = {
    opus: ["Karaoke bold", "Arial Black", 58, "#ffffff", "#19ff47", "#000000", 3, "Pop"],
    capcut: ["TikTok style", "Arial Black", 56, "#ffffff", "#19ff47", "#000000", 3, "Scale"],
    tiktok: ["TikTok style", "Arial Black", 60, "#ffffff", "#24ff5a", "#000000", 4, "Bounce"],
    news: ["Clean subtitle", "Arial", 46, "#ffffff", "#ffd54a", "#10202a", 1, "Fade"],
    podcast: ["YouTube Shorts style", "Arial Black", 52, "#ffffff", "#20e070", "#000000", 2, "Pop"],
    gaming: ["Karaoke bold", "Arial Black", 62, "#ffffff", "#ffdd00", "#000000", 4, "Bounce"]
  };
  const next = presets[preset] || presets.opus;
  setValue("#captionStyle", next[0]);
  setValue("#subtitleFontFamily", next[1]);
  setValue("#subtitleFontSize", next[2]);
  setValue("#subtitlePrimaryColor", next[3]);
  setValue("#subtitleActiveColor", next[4]);
  setValue("#subtitleStrokeColor", next[5]);
  setValue("#subtitleShadow", next[6]);
  setValue("#subtitleAnimation", next[7]);
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
    setValue("#subtitleFontSize", "60");
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
  const preview = $("#subtitlePreviewText");
  if (!preview) return;
  refreshSubtitleFontFace();
  const words = (fieldValue("subtitlePreviewInput", "TAPI GUE HERAN") || "TAPI GUE HERAN").trim().split(/\s+/);
  const activeIndex = words.length > 1 ? 1 : 0;
  preview.innerHTML = words.map((word, index) => {
    const safeWord = escapeHtml(word);
    return index === activeIndex ? `<span>${safeWord}</span>` : safeWord;
  }).join(" ");
  preview.style.fontFamily = `"${fieldValue("subtitleFontFamily", "Arial Black")}", Arial, sans-serif`;
  preview.style.fontSize = `${Math.max(28, Math.min(96, numberField("subtitleFontSize", 60))) * 0.52}px`;
  preview.style.color = fieldValue("subtitlePrimaryColor", "#ffffff");
  const active = preview.querySelector("span");
  if (active) active.style.color = fieldValue("subtitleActiveColor", "#19ff47");
  const shadow = numberField("subtitleShadow", 4);
  preview.style.textShadow = shadow ? `0 ${shadow}px 0 ${fieldValue("subtitleStrokeColor", "#000000")}, 0 0 ${shadow * 4}px rgba(0,0,0,.75)` : "none";
}

function bindPreviewDrag(element, xId, yId) {
  if (!element) return;
  element.addEventListener("pointerdown", (event) => {
    const frame = $("#brandPreviewFrame");
    if (!frame) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const rect = frame.getBoundingClientRect();
      const x = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      const y = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      setValue(`#${xId}`, Math.round(Math.max(0, Math.min(100, x))));
      setValue(`#${yId}`, Math.round(Math.max(0, Math.min(100, y))));
      updateBrandPreview();
    };
    const stop = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", stop);
      element.removeEventListener("pointercancel", stop);
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
    setText("#pipelineEstimate", `Estimasi: ${formatDuration(estimateRenderSeconds())}`);
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
  setText("#pipelineEstimate", `Estimasi: ${formatDuration(estimateRenderSeconds())}`);
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
    fileName: meta.fileName || path.split(/[\\/]/).pop() || "cookies.txt",
    sizeBytes: meta.sizeBytes || meta.size || 0,
    importedAt: config.cookies_last_import || meta.importedAt || meta.importDate || "",
    lastUsed: config.cookies_last_used || meta.lastUsed || "",
    lastTest: config.cookies_last_test || meta.lastTest || "",
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
  const age = daysSince(importedAt);
  const statusTitle = hasCookies ? "Cookies Loaded" : "Cookies belum dipasang";
  const statusBadge = hasCookies ? "Loaded" : "Belum dipasang";
  const stale = hasCookies && age !== null && age > 7;

  setText("#cookiesStatusTitle", hasCookies ? "✓ Cookies Loaded" : "⚠ Cookies belum dipasang");
  setText("#cookiesStatusBadge", stale ? "Perlu update" : statusBadge);
  setText("#cookiesFileName", hasCookies ? info.fileName : "-");
  setText("#cookiesFileSize", hasCookies ? formatBytes(info.sizeBytes) : "-");
  setText("#cookiesImportDate", hasCookies ? formatDate(importedAt) : "-");
  setText("#cookiesLastUsed", hasCookies ? formatDate(info.lastUsed) : "-");
  setText("#cookiesAge", hasCookies ? cookieAgeText(importedAt) : "-");
  setText("#cookiesTestStatus", hasCookies ? (info.testStatus || info.status || "Belum dites") : "Belum dites");
  setText("#cookiesTestUrl", hasCookies ? (info.testUrl || "-") : "-");
  setText("#cookieState", hasCookies ? info.path : "Belum dipilih");
  setText("#cookiesAgeBadge", stale ? "Cookies mungkin perlu diperbarui." : statusTitle);

  const badge = $("#cookiesAgeBadge");
  if (badge) {
    badge.classList.toggle("warning", Boolean(stale));
    badge.classList.toggle("ok", hasCookies && !stale);
  }
  const status = $("#cookiesStatusBadge");
  if (status) {
    status.classList.toggle("warning", Boolean(stale));
    status.classList.toggle("ok", hasCookies && !stale);
  }
}

function renderRuntimeList(deps = state.dependencies) {
  const list = $("#runtimeList");
  if (!list) return;
  const items = [
    ["Python", deps?.python?.version || (deps?.python?.ok ? "Ready" : "Belum dicek"), deps?.python?.ok],
    ["yt-dlp", deps?.yt_dlp?.version || (deps?.yt_dlp?.ok ? "Ready" : "Belum dicek"), deps?.yt_dlp?.ok],
    ["FFmpeg", deps?.ffmpeg?.ok ? "Ready" : "Belum dicek", deps?.ffmpeg?.ok],
    ["FFprobe", deps?.ffprobe?.ok ? "Ready" : "Belum dicek", deps?.ffprobe?.ok],
    ["OpenAI SDK", deps?.openai?.ok ? "Ready" : "Opsional", deps?.openai?.ok],
    ["OpenCV face tracking", deps?.opencv?.ok ? deps.opencv.version : "Fallback crop", deps?.opencv?.ok],
    ["MediaPipe", deps?.mediapipe?.ok ? deps.mediapipe.version : "Opsional", deps?.mediapipe?.ok],
    ["GPU encoder", deps?.encoders?.available?.length ? deps.encoders.available.join(", ") : "CPU fallback", deps?.encoders?.available?.some((item) => item !== "libx264")],
    ["Auto Video Enhancement", "Always active", true]
  ];
  list.innerHTML = items
    .map(([name, value, ok]) => `
      <div class="runtime-item ${ok ? "ok" : ""}">
        <span>${name}</span>
        <strong>${value}</strong>
      </div>
    `)
    .join("");
}

function setSettingsTab(tab) {
  state.activeSettingsTab = tab;
  $$(".settings-tab").forEach((button) => button.classList.toggle("active", button.dataset.settingsTab === tab));
  $$(".settings-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `settings-${tab}`));
}

function isValidYoutubeUrl(url) {
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/.test(String(url).trim());
}

function isAiEnabled() {
  const payload = providerPayload();
  return payload.providerType === "cloud" && Boolean(payload.apiKey && payload.baseUrl && payload.model);
}

let metadataTimer = null;
let metadataUrl = "";

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
    return;
  }
  if (!isValidYoutubeUrl(url)) {
    setText("#previewTitle", "URL tidak valid");
    setText("#previewUrl", url || "Masukkan link YouTube");
    return;
  }
  if (aiProviderRequiresConnectedStatus()) {
    setView("settings");
    setSettingsTab("api");
    toast("Hubungkan Cliper AI Cloud terlebih dahulu");
    return;
  }
  metadataUrl = url;
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
    if (result.type === "error") {
      setText("#previewTitle", "Metadata gagal");
      setText("#subtitleMetric", "Metadata error");
      pushLog(`[metadata] gagal: ${result.message}`);
      return;
    }
    const data = result.result;
    state.videoDuration = Number(data.video?.duration || 0);
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
    pushLog(`[metadata] berhasil dimuat: ${data.video?.title || url}`);
  } catch (error) {
    setText("#previewTitle", "Metadata gagal");
    setText("#subtitleMetric", "Metadata error");
    pushLog(`[metadata] error: ${error?.message || error}`);
  }
}

function scheduleMetadataFetch() {
  const url = $("#youtubeUrl").value.trim();
  if (!url || url === metadataUrl) {
    return;
  }
  clearTimeout(metadataTimer);
  metadataTimer = setTimeout(() => fetchMetadata(url), 700);
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
          </div>
          <span class="status-chip">${session.status}</span>
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
  const provider = aiProviderDefaults.cloud;
  const model = "Auto";
  const ready = Boolean(payload.providerType === "cloud" && payload.baseUrl && payload.apiKey);
  const statusText = $("#providerStatusText")?.textContent || "";
  const features = payload.aiFeatures || aiFeatureConfig();
  const activeFeatureCount = Object.values(features).filter(Boolean).length;
  if (/connected|valid|sukses|ready/i.test(statusText)) {
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
          aiTitleToggle: "title",
          aiTtsToggle: "tts"
        }[toggleId];
        const enabled = Boolean(features[key]);
        const engine = enabled && ready ? `${provider.label} · ${model}` : "Menunggu koneksi cloud";
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

function providerPayload() {
  const apiKey = $("#apiKey")?.value?.trim();
  const features = aiFeatureConfig();
  const selectedModel = "auto";
  const maxTokensByModule = {
    test: 320,
    highlight: 1600,
    title: 480,
    hook: 420,
    caption: 700,
    tts: 360
  };
  const timeoutMsByModule = {
    test: 30000,
    highlight: 90000,
    title: 45000,
    hook: 45000,
    caption: 45000,
    tts: 45000,
    default: 45000
  };
  const aiRetryByModule = {
    highlight: 3,
    title: 2,
    hook: 2,
    caption: 2,
    test: 2,
    default: 2
  };
  const baseUrl = aiProviderDefaults.cloud.baseUrl;
  return {
    providerType: "cloud",
    baseUrl,
    apiKey,
    model: selectedModel,
    highlightModel: selectedModel,
    moduleModels: {
      highlight: selectedModel,
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

function setProviderStatus(message, ok = false) {
  setText("#providerStatusText", message);
  const box = $("#providerStatusBox");
  if (box) {
    box.classList.toggle("ok", ok);
    box.classList.toggle("warning", !ok && message !== "Belum dites");
  }
  renderProviders();
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
  const estimateRp = Math.ceil((input + output) / 1000 * 8);
  state.aiUsageToday = {
    date: todayKey(),
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + output,
    estimatedCostRp: current.estimatedCostRp + estimateRp
  };
  renderAiUsage();
}

function renderAiUsage() {
  const usage = normalizeAiUsage(state.aiUsageToday);
  state.aiUsageToday = usage;
  setText("#aiTokenSummary", `${usage.inputTokens.toLocaleString("id-ID")} input / ${usage.outputTokens.toLocaleString("id-ID")} output tokens`);
  setText("#aiCostSummary", `Estimated cost: Rp ${usage.estimatedCostRp.toLocaleString("id-ID")}`);
}

function providerErrorMessage(status, payload) {
  const text = String(status || "Test API gagal");
  if (/invalid|unauthorized|401|forbidden|api key/i.test(text)) {
    return `Invalid API key - pastikan key cocok untuk ${aiProviderDefaults[payload.providerType]?.label || payload.providerType}`;
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
  const providerType = "cloud";
  const preset = aiProviderDefaults.cloud;
  const base = $("#baseUrl");
  const key = $("#apiKey");
  const model = $("#highlightModel");
  const isKnownDefault = Object.values(aiProviderDefaults).some((item) => item.baseUrl && item.baseUrl === base?.value);
  if (base && (force || !base.value || isKnownDefault)) {
    base.value = preset.baseUrl;
  }
  if (model) {
    model.value = "auto";
    model.readOnly = true;
  }
  if (key) {
    key.disabled = false;
    key.placeholder = "clip_sk_xxxxxxxxx";
  }
  if (base) {
    base.value = preset.baseUrl;
    base.disabled = true;
  }
  const connected = /connected|valid|sukses|ready/i.test($("#providerStatusText")?.textContent || "");
  setProviderStatus(key?.value?.trim() ? (connected ? $("#providerStatusText").textContent : "API key tersimpan · test connection") : "Cliper AI Cloud belum terhubung", connected);
  setText("#apiStatus", key?.value?.trim() ? "Cliper Cloud API key tersimpan" : "Cliper AI Cloud belum terhubung");
  renderProviders();
}

async function testProvider(options = {}) {
  const payload = providerPayload();
  const preset = aiProviderDefaults.cloud;
  if (!payload.apiKey) {
    const status = "API key Cliper AI Cloud wajib diisi";
    setProviderStatus(status, false);
    setText("#apiStatus", "Cliper AI Cloud belum terhubung");
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
  pushLog(`[ai] Test API request sent to ${preset.label}, model=${payload.model}, key=${maskedKey}`);
  const start = performance.now();
  const result = await window.cliper.testProvider(payload);
  const duration = Math.round(performance.now() - start);
  const response = result?.type === "done" ? result.result : result;
  if (result?.type === "error" || !response?.ok) {
    const status = response?.status || response?.message || result?.message || "Test API gagal";
    const message = providerErrorMessage(status, payload);
    setProviderStatus(message, false);
    pushLog(`[ai] Test API failed provider=${payload.providerType} baseUrl=${payload.baseUrl} model=${payload.model} error=${status}`);
    toast(message);
    await saveConfig({ silent: true });
    return response || { ok: false, status };
  }
  const responseText = response.response || "OK";
  const usage = response.usage ? `usage=${JSON.stringify(response.usage)}` : "usage=unknown";
  addAiUsage(response.usage_total || response.usage || {});
  setProviderStatus(`Connected ✓ ${payload.providerType}`, true);
  setText("#apiStatus", `Connected ✓ ${payload.providerType}`);
  pushLog(`[ai] Test API response received in ${duration}ms, ${usage}`);
  pushLog(`[ai] provider=${payload.providerType} model=${payload.model} response=${responseText}`);
  if (payload.providerType === "cloud" && response.license) {
    pushLog(`[cloud] plan=${response.license.plan || "-"} status=${response.license.status || "active"} credits=${response.license.credits || 0}`);
  }
  state.apiLastLatencyMs = duration;
  state.apiLastResponse = responseText;
  if (!options.silent) toast("Test API sukses");
  await saveConfig({ silent: true });
  return { ...response, latencyMs: duration };
}

function aiProviderRequiresConnectedStatus() {
  const payload = providerPayload();
  if (payload.providerType !== "cloud" || !payload.apiKey) return true;
  const status = $("#providerStatusText")?.textContent || "";
  return !/connected|valid|sukses|ready/i.test(status);
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
  setText("#subtitleMetric", deps.yt_dlp?.ok ? "yt-dlp ready" : "yt-dlp missing");
  setText("#apiStatus", deps.ffmpeg?.ok ? "FFmpeg ready" : "FFmpeg belum ada");
  setText("#runtimeMetric", deps.ffmpeg?.ok ? "Runtime ready" : "FFmpeg belum ada");
  setText("#detectedGpu", "Auto detect aktif setelah FFmpeg tersedia");
  setText("#activeEncoder", $("#gpuToggle")?.checked && deps.ffmpeg?.ok ? "h264_amf jika tersedia, fallback libx264" : "CPU fallback - libx264");
  pushLog(`[dependency] python=${deps.python?.version || "-"} yt-dlp=${deps.yt_dlp?.ok ? deps.yt_dlp.version : "missing"} ffmpeg=${deps.ffmpeg?.ok ? "ready" : "missing"}`);
  toast("Dependency dicek");
}

async function findMoments() {
  setSourceMode("youtube");
  const target = Math.max(1, Math.min(20, Number($("#clipCount").value) || 6));
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
    const message = providerPayload().apiKey ? "Test API Cliper AI Cloud dulu sampai Connected." : "Masukkan API key Cliper AI Cloud terlebih dahulu.";
    pushLog(`[ai] analisa diblokir: ${message}`);
    toast(message);
    return;
  }

  clearInterval(state.processingTimer);
  state.progress = 0;
  resetStepStatus("analyze");
  $("#progressBar").style.width = "0%";
  $("#jobBadge").textContent = "Analyzing";
  setText("#renderScreenTitle", "Finding highlights...");
  setText("#renderScreenSubtitle", "Downloading subtitle and analyzing the transcript with AI.");
  updateRenderStats({ progress: 0, stage: "Download subtitle", clipIndex: null, totalClips: null });
  renderSteps();
  pushLog(`[analyze] mulai analisa nyata: ${$("#youtubeUrl").value}`);
  setView("render");
  const result = await window.cliper.analyze(collectPayload());
  if (result.type === "error") {
    $("#jobBadge").textContent = "Error";
    pushLog(`[error] ${result.message}`);
    toast(result.message);
    return;
  }

  const data = result.result || {};
  addAiUsage(data.ai_usage || {});
  const diagnostics = data.ai_diagnostics || {};
  const aiStatus = diagnostics.ai_used
    ? `Cliper AI Cloud aktif · ${diagnostics.requests || 0} request · ${diagnostics.retry_count || 0} retry`
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
  state.lastTranscript = Array.isArray(data.transcript) ? normalizeTranscriptSegments(data.transcript) : [];
  state.videoDuration = Number(data.video?.duration || state.videoDuration || 0);
  if (data.video?.used_cookies) {
    await markCookiesUsed();
    pushLog("[cookies] digunakan otomatis setelah video meminta login/age verification");
  }
  if (data.video?.source_path) {
    pushLog(`[cache] ${data.video.cache_status === "cached" ? "Using cached source" : "Source cached"}: ${data.video.source_path}`);
  }
  momentBank = (data.moments || []).map((item, index) => normalizeMomentForUi(item, index, data.video || {}));
  if (!momentBank.length) {
    pushLog("[highlight] worker selesai tanpa moment; empty-state ditampilkan dan UI tetap responsif");
  }
  state.selectedMoments = new Set(momentBank.filter((item) => item.autoRender && item.renderEligible !== false).map((item) => item.id));
  state.activeMomentId = momentBank[0]?.id || null;
  $("#previewTitle").textContent = data.video?.title || "YouTube video";
  $("#previewUrl").textContent = data.video?.webpage_url || $("#youtubeUrl").value;
  $("#subtitleMetric").textContent = data.video?.subtitle_language || "No subtitle";
  $("#previewScore").textContent = momentBank[0]?.score || "-";
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
    const message = payload.apiKey ? "Test API Cliper AI Cloud dulu sampai Connected." : "Masukkan API key Cliper AI Cloud terlebih dahulu.";
    pushLog(`[ai] render diblokir: ${message}`);
    toast(message);
    return;
  }

  if (window.cliper) {
    clearInterval(state.processingTimer);
    state.progress = 0;
    state.renderErrors = [];
    resetStepStatus("render");
    state.renderStartedAt = Date.now();
    setText("#renderScreenTitle", "Processing clips...");
    setText("#renderScreenSubtitle", `Processing ${clips.length} clips with automatic AI production pipeline.`);
    updateRenderStats({ progress: 0, stage: "Download video sections", clipIndex: 1, totalClips: clips.length });
    renderPipelinePreview();
    renderSteps();
    $("#jobBadge").textContent = "Rendering";
    pushLog(`[render] mulai render nyata ${clips.length} clip`);
    setView("render");
    const result = await window.cliper.render({ ...collectPayload(), moments: selectedMomentPayload() });
    if (result.type === "error") {
      $("#jobBadge").textContent = "Error";
      pushLog(`[error] ${result.message}`);
      toast(result.message);
      return;
    }
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
    const outputCount = outputs.length;
    $("#jobBadge").textContent = outputCount ? "Complete" : "Error";
    sessions.unshift({
      name: result.result?.manifest?.title || "YouTube clip session",
      clips: outputCount,
      date: "Baru saja",
      status: outputCount ? (warningCount ? `Selesai + warning (${validCount}/${requestedCount})` : "Selesai") : "Gagal",
      size: result.result?.sessionDir || "Lihat folder",
      folder: result.result?.sessionDir || ""
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
  const config = {
    providerType: "cloud",
    baseUrl: aiProviderDefaults.cloud.baseUrl,
    apiKey: fieldValue("apiKey"),
    highlightModel: "auto",
    aiHighlightToggle: fieldValue("aiHighlightToggle", true),
    aiHookToggle: fieldValue("aiHookToggle", true),
    aiCaptionToggle: fieldValue("aiCaptionToggle", true),
    aiTitleToggle: fieldValue("aiTitleToggle", true),
    aiTtsToggle: fieldValue("aiTtsToggle", false),
    providerStatus: $("#providerStatusText")?.textContent || "Cliper AI Cloud belum terhubung",
    apiStatus: $("#apiStatus")?.textContent || "Cliper AI Cloud belum terhubung",
    apiLastTestedAt: state.apiLastTestedAt || "",
    apiLastLatencyMs: state.apiLastLatencyMs || 0,
    apiLastResponse: state.apiLastResponse || "",
    aiUsageToday: normalizeAiUsage(state.aiUsageToday),
    clipCount: fieldValue("clipCount", "6"),
    scoreMode: fieldValue("scoreMode", "Random Viral Mix"),
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
    formatProfile: fieldValue("formatProfile", "9:16 YouTube Shorts"),
    resolutionProfile: fieldValue("resolutionProfile", "1080p"),
    crfProfile: fieldValue("crfProfile", "23"),
    fpsProfile: fieldValue("fpsProfile", "Same as source"),
    captionStyle: fieldValue("captionStyle", "TikTok style"),
    subtitleBurnToggle: fieldValue("subtitleBurnToggle", false),
    hookOpeningToggle: fieldValue("hookOpeningToggle", false),
    hookDuration: fieldValue("hookDuration", "3 seconds"),
    subtitlePreviewInput: fieldValue("subtitlePreviewInput", "TAPI GUE HERAN"),
    subtitleFontFamily: fieldValue("subtitleFontFamily", "Arial Black"),
    subtitleFontPath: fieldValue("subtitleFontPath", ""),
    subtitleFontSize: fieldValue("subtitleFontSize", "60"),
    subtitlePrimaryColor: fieldValue("subtitlePrimaryColor", "#ffffff"),
    subtitleActiveColor: fieldValue("subtitleActiveColor", "#19ff47"),
    subtitleStrokeColor: fieldValue("subtitleStrokeColor", "#000000"),
    subtitleShadow: fieldValue("subtitleShadow", "4"),
    subtitleAnimation: fieldValue("subtitleAnimation", "Scale"),
    ttsHookToggle: fieldValue("ttsHookToggle", false),
    audioEnhanceToggle: fieldValue("audioEnhanceToggle", true),
    thumbnailPreviewToggle: fieldValue("thumbnailPreviewToggle", false),
    watermarkEnabled: fieldValue("watermarkEnabled", false),
    watermarkInOutput: fieldValue("watermarkInOutput", false),
    logoAssetPath: fieldValue("logoAssetPath", ""),
    logoX: fieldValue("logoX", "82"),
    logoY: fieldValue("logoY", "8"),
    logoScale: fieldValue("logoScale", "18"),
    logoOpacity: fieldValue("logoOpacity", "90"),
    logoRotation: fieldValue("logoRotation", "0"),
    watermarkText: fieldValue("watermarkText"),
    watermarkOpacity: fieldValue("watermarkOpacity", "68"),
    watermarkPosition: fieldValue("watermarkPosition", "Top right"),
    watermarkTextX: fieldValue("watermarkTextX", "78"),
    watermarkTextY: fieldValue("watermarkTextY", "16"),
    watermarkTextSize: fieldValue("watermarkTextSize", "28"),
    watermarkTextColor: fieldValue("watermarkTextColor", "#ffffff"),
    watermarkTextStroke: fieldValue("watermarkTextStroke", "#000000"),
    watermarkTextShadow: fieldValue("watermarkTextShadow", "2"),
    watermarkFontFamily: fieldValue("watermarkFontFamily", "Arial Black"),
    watermarkFontPath: fieldValue("watermarkFontPath", ""),
    gpuToggle: fieldValue("gpuToggle", false),
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
  const legacyProvider = Boolean(config.providerType && config.providerType !== "cloud");
  if (legacyProvider) {
    config = {
      ...config,
      providerType: "cloud",
      baseUrl: aiProviderDefaults.cloud.baseUrl,
      highlightModel: "auto",
      apiKey: "",
      providerStatus: "Legacy provider removed. Enter a Cliper AI Cloud key."
    };
  }
  state.config = config;
  setValue("#providerType", "cloud");
  setValue("#baseUrl", aiProviderDefaults.cloud.baseUrl);
  setValue("#apiKey", config.apiKey || "");
  setValue("#highlightModel", "auto");
  applyProviderDefaults(false);
  setValue("#aiHighlightToggle", config.aiHighlightToggle ?? true);
  setValue("#aiHookToggle", config.aiHookToggle ?? true);
  setValue("#aiCaptionToggle", config.aiCaptionToggle ?? true);
  setValue("#aiTitleToggle", config.aiTitleToggle ?? true);
  setValue("#aiTtsToggle", config.aiTtsToggle ?? false);
  setValue("#clipCount", config.clipCount || "6");
  setValue("#scoreMode", config.scoreMode || "Random Viral Mix");
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
  setValue("#formatProfile", config.formatProfile || "9:16 YouTube Shorts");
  state.apiLastTestedAt = config.apiLastTestedAt || "";
  state.apiLastLatencyMs = config.apiLastLatencyMs || 0;
  state.apiLastResponse = config.apiLastResponse || "";
  state.aiUsageToday = normalizeAiUsage(config.aiUsageToday || {});
  setValue("#resolutionProfile", config.resolutionProfile || "1080p");
  setValue("#crfProfile", config.crfProfile || "23");
  setValue("#fpsProfile", config.fpsProfile || "Same as source");
  setValue("#captionStyle", config.captionStyle || "TikTok style");
  setValue("#subtitleBurnToggle", config.subtitleBurnToggle ?? false);
  setValue("#hookOpeningToggle", config.hookOpeningToggle ?? false);
  setValue("#hookDuration", config.hookDuration || "3 seconds");
  setValue("#subtitlePreviewInput", config.subtitlePreviewInput || "TAPI GUE HERAN");
  setValue("#subtitleWordHighlightToggle", config.subtitleWordHighlight ?? true);
  setValue("#subtitleFontFamily", config.subtitleFontFamily || "Arial Black");
  setValue("#subtitleFontPath", config.subtitleFontPath || "");
  setValue("#subtitleFontSize", config.subtitleFontSize || "60");
  setValue("#subtitlePrimaryColor", config.subtitlePrimaryColor || "#ffffff");
  setValue("#subtitleActiveColor", !config.subtitleActiveColor || config.subtitleActiveColor === "#ffe600" ? "#19ff47" : config.subtitleActiveColor);
  setValue("#subtitleStrokeColor", config.subtitleStrokeColor || "#000000");
  setValue("#subtitleShadow", config.subtitleShadow || "4");
  setValue("#subtitleAnimation", config.subtitleAnimation || "Scale");
  setValue("#ttsHookToggle", config.ttsHookToggle ?? false);
  setValue("#audioEnhanceToggle", config.audioEnhanceToggle ?? true);
  setValue("#thumbnailPreviewToggle", config.thumbnailPreviewToggle ?? false);
  setValue("#watermarkEnabled", config.watermarkEnabled ?? false);
  setValue("#watermarkInOutput", config.watermarkInOutput ?? false);
  setValue("#logoAssetPath", config.logoAssetPath || "");
  setValue("#logoX", config.logoX || "82");
  setValue("#logoY", config.logoY || "8");
  setValue("#logoScale", config.logoScale || "18");
  setValue("#logoOpacity", config.logoOpacity || "90");
  setValue("#logoRotation", config.logoRotation || "0");
  setValue("#watermarkText", config.watermarkText || "");
  setValue("#watermarkOpacity", config.watermarkOpacity || "68");
  setValue("#watermarkPosition", config.watermarkPosition || "Top right");
  setValue("#watermarkTextX", config.watermarkTextX || "78");
  setValue("#watermarkTextY", config.watermarkTextY || "16");
  setValue("#watermarkTextSize", config.watermarkTextSize || "28");
  setValue("#watermarkTextColor", config.watermarkTextColor || "#ffffff");
  setValue("#watermarkTextStroke", config.watermarkTextStroke || "#000000");
  setValue("#watermarkTextShadow", config.watermarkTextShadow || "2");
  setValue("#watermarkFontFamily", config.watermarkFontFamily || "Arial Black");
  setValue("#watermarkFontPath", config.watermarkFontPath || "");
  setValue("#gpuToggle", config.gpuToggle ?? false);
  setValue("#overwriteExisting", config.overwriteExisting ?? false);
  setValue("#autoRename", config.autoRename ?? true);
  setValue("#createProjectFolder", config.createProjectFolder ?? true);
  setValue("#deleteTempAfterExport", config.deleteTempAfterExport ?? true);
  state.cookiesInfo = normalizeCookiesInfo(config);
  state.cookiesPath = state.cookiesInfo?.path || "";
  setText("#apiStatus", !config.apiKey ? "Cliper AI Cloud belum terhubung" : "Cliper Cloud API key tersimpan");
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
  setText("#apiStatus", config.apiKey ? "Cliper Cloud API key tersimpan" : "Cliper AI Cloud belum terhubung");
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
  const browserSafeConfig = { ...config };
  delete browserSafeConfig.apiKey;
  localStorage.setItem("cliper-config", JSON.stringify(browserSafeConfig));
  if (config.providerType && config.providerType !== "cloud") {
    pushLog("[config] provider lama dihapus; Settings sekarang hanya memakai Cliper AI Cloud");
    config = {
      ...config,
      providerType: "cloud",
      baseUrl: aiProviderDefaults.cloud.baseUrl,
      highlightModel: "auto",
      apiKey: ""
    };
  }
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

  toast("Importing cookies...");
  setText("#cookiesTestStatus", "Importing cookies...");
  pushLog(`[cookies] validasi ${filePath}`);
  const result = await window.cliper.validateCookies({ cookiesPath: filePath });
  const validation = result.result || {};
  if (result.type === "error" || !validation.ok) {
    const reason = validation.reason || result.message || "Cookies tidak valid. Silakan export ulang.";
    setText("#cookiesTestStatus", reason);
    pushLog(`[cookies] invalid: ${reason}`);
    toast("Cookies tidak valid. Silakan export ulang.");
    return;
  }

  const now = new Date().toISOString();
  state.cookiesPath = validation.path || filePath;
  state.cookiesInfo = {
    path: state.cookiesPath,
    fileName: validation.fileName || filePath.split(/[\\/]/).pop() || "cookies.txt",
    sizeBytes: validation.sizeBytes,
    importedAt: now,
    lastUsed: "",
    lastTest: "",
    status: "Cookies Loaded",
    testStatus: validation.warning || "Cookies berhasil dimuat.",
    validation
  };
  await saveConfig({ silent: true });
  renderCookiesManager();
  pushLog("[cookies] Cookies berhasil dimuat.");
  toast("Cookies berhasil dimuat.");
}

async function importCookies() {
  if (window.cliper?.selectCookieFile) {
    const filePath = await window.cliper.selectCookieFile();
    await validateAndStoreCookies(filePath);
    return;
  }
  $("#cookieFile")?.click();
}

async function testCookies() {
  if (!state.cookiesPath) {
    toast("Import cookies dulu");
    setSettingsTab("cookies");
    return;
  }
  const youtubeUrl = $("#youtubeUrl")?.value.trim();
  if (!youtubeUrl) {
    toast("Masukkan URL YouTube untuk test cookies.");
    setView("studio");
    return;
  }
  if (!window.cliper?.testCookies) {
    toast("Test cookies tersedia di .exe");
    return;
  }
  toast("Testing cookies...");
  setText("#cookiesTestStatus", "Testing cookies...");
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
      testUrl: youtubeUrl
    };
    await saveConfig({ silent: true });
    pushLog(`[cookies] test gagal: ${status}`);
    toast(status);
    return;
  }
  state.cookiesInfo = {
    ...(state.cookiesInfo || {}),
    lastTest: now,
    testStatus: "✓ Cookies valid",
    status: "Cookies Loaded",
    testUrl: youtubeUrl
  };
  await saveConfig({ silent: true });
  pushLog(`[cookies] valid untuk test video: ${data.lastTestVideo || "-"}`);
  toast("✓ Cookies valid");
}

async function removeCookies() {
  state.cookiesPath = "";
  state.cookiesInfo = null;
  await saveConfig({ silent: true });
  renderCookiesManager();
  toast("Cookies dihapus dari config");
}

async function detectGpu() {
  setText("#detectedGpu", "Detecting GPU...");
  await scanSubtitles();
  const hasFfmpeg = state.dependencies?.ffmpeg?.ok;
  setText("#detectedGpu", hasFfmpeg ? "FFmpeg ready - GPU encoder akan dicoba otomatis saat render" : "GPU belum terdeteksi. CPU fallback aktif.");
  setText("#activeEncoder", hasFfmpeg && $("#gpuToggle")?.checked ? "h264_amf jika tersedia, fallback libx264" : "CPU fallback - libx264");
  toast("GPU/runtime selesai dicek");
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$(".settings-tab").forEach((button) => button.addEventListener("click", () => setSettingsTab(button.dataset.settingsTab)));

  $("#youtubeUrl").addEventListener("input", (event) => {
    setSourceMode("youtube");
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
    $("#previewUrl").textContent = text.trim();
    scheduleMetadataFetch();
    toast("URL ditempel");
  });

  $("#clipCount").addEventListener("input", updateCounters);
  $("#clipCount").addEventListener("input", renderPipelinePreview);
  ["aiHighlightToggle", "aiHookToggle", "aiCaptionToggle", "aiTitleToggle", "aiTtsToggle"].forEach((id) => {
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
  ["watermarkEnabled", "watermarkInOutput", "gpuToggle", "formatProfile", "resolutionProfile", "fpsProfile", "crfProfile"].forEach((id) => {
    const node = $(`#${id}`);
    if (node) node.addEventListener("change", renderPipelinePreview);
  });
  ["selectionMode", "rangeStart", "rangeEnd", "multipleRanges"].forEach((id) => {
    const node = $(`#${id}`);
    if (node) {
      node.addEventListener("input", updateTimelinePreview);
      node.addEventListener("change", updateTimelinePreview);
    }
  });
  $("#analysisStartRange")?.addEventListener("input", () => updateAnalysisRangeFromSeekbar("start"));
  $("#analysisEndRange")?.addEventListener("input", () => updateAnalysisRangeFromSeekbar("end"));
  ["logoScale", "logoOpacity", "logoRotation", "watermarkText", "watermarkOpacity", "watermarkTextSize", "watermarkTextColor", "watermarkTextStroke", "watermarkTextShadow", "watermarkFontFamily", "watermarkFontPath"].forEach((id) => {
    const node = $(`#${id}`);
    if (node) {
      node.addEventListener("input", updateBrandPreview);
      node.addEventListener("change", updateBrandPreview);
    }
  });
  ["subtitlePreviewInput", "subtitleFontFamily", "subtitleFontSize", "subtitlePrimaryColor", "subtitleActiveColor", "subtitleStrokeColor", "subtitleShadow", "subtitleAnimation"].forEach((id) => {
    const node = $(`#${id}`);
    if (node) {
      node.addEventListener("input", updateSubtitlePreview);
      node.addEventListener("change", updateSubtitlePreview);
    }
  });
  $$("[data-brand-preset]").forEach((button) => {
    button.addEventListener("click", () => setBrandPreset(button.dataset.brandPreset));
  });
  $$("[data-subtitle-preset]").forEach((button) => {
    button.addEventListener("click", () => applySubtitlePreset(button.dataset.subtitlePreset));
  });
  bindPreviewDrag($("#brandPreviewLogo"), "logoX", "logoY");
  bindPreviewDrag($("#brandPreviewText"), "watermarkTextX", "watermarkTextY");
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
  $("#momentSort")?.addEventListener("change", (event) => {
    state.momentSort = event.target.value;
    renderMoments();
  });
  $("#processSelected").addEventListener("click", openProcessDialog);

  $("#momentGrid").addEventListener("change", (event) => {
    const id = Number(event.target.dataset.toggleMoment);
    if (!id) return;
    const item = momentBank.find((moment) => moment.id === id);
    if (item?.renderEligible === false) {
      event.target.checked = false;
      state.selectedMoments.delete(id);
      toast("Score di bawah 65 belum layak render otomatis");
      renderMoments();
      return;
    }
    if (event.target.checked) {
      state.selectedMoments.add(id);
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
    if (event.target.closest("input, button, a, select, textarea")) {
      // Button-specific handlers below still run because they are checked first.
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
      if (item?.renderEligible === false) {
        toast("Score di bawah 65. Edit atau regenerate dulu sebelum render.");
        return;
      }
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
    const button = event.target.closest("[data-open-session]");
    if (!button) return;
    openSessionFolder(button.dataset.openSession);
  });

  $("#selectAllButton").addEventListener("click", () => {
    const visibleMoments = momentBank.filter((item) => !item.rejected && item.renderEligible !== false);
    const allSelected = visibleMoments.length > 0 && visibleMoments.every((item) => state.selectedMoments.has(item.id));
    state.selectedMoments = new Set(allSelected ? [] : visibleMoments.map((item) => item.id));
    $("#selectAllButton").textContent = allSelected ? "Pilih semua" : "Kosongkan";
    renderMoments();
    updateProcessButtons();
  });

  $("#cancelJob").addEventListener("click", async () => {
    if (window.cliper) {
      await window.cliper.cancel();
      $("#jobBadge").textContent = "Cancelled";
      pushLog("[cancelled] worker dibatalkan");
      toast("Worker dibatalkan");
      return;
    }
    if (!state.processingTimer) return;
    clearInterval(state.processingTimer);
    state.processingTimer = null;
    $("#jobBadge").textContent = "Cancelled";
    state.logLines.push("[cancelled] render dibatalkan user");
    renderLogs();
    toast("Render dibatalkan");
  });

  $("#resetButton").addEventListener("click", () => {
    setSourceMode("youtube");
    $("#youtubeUrl").value = "";
    $("#previewUrl").textContent = "Masukkan link YouTube";
    $("#previewTitle").textContent = "Belum ada video";
    $("#previewScore").textContent = "-";
    state.previewImageUrl = "";
    $("#clipCount").value = 6;
    state.lastAnalysis = null;
    state.lastTranscript = [];
    state.activeMomentId = null;
    state.selectedMoments = new Set();
    momentBank = [];
    updateCounters();
    renderMoments();
    drawPreview();
    toast("Form direset");
  });

  $("#refreshPreview").addEventListener("click", drawPreview);
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
  $("#detectGpuButton").addEventListener("click", detectGpu);
  applyProviderDefaults(true);
  $("#apiKey").addEventListener("input", () => {
    renderProviders();
    setProviderStatus($("#apiKey").value.trim() ? "API key tersimpan · test connection" : "Cliper AI Cloud belum terhubung", false);
    setText("#apiStatus", $("#apiKey").value.trim() ? "Cliper Cloud API key tersimpan" : "Cliper AI Cloud belum terhubung");
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
  $("#importCookiesButton").addEventListener("click", importCookies);
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

  if (window.cliper) {
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
  await loadConfig();
  bindEvents();
  renderMoments();
  renderSteps();
  renderLogs();
  renderSessions();
  renderProviders();
  renderCookiesManager();
  renderRuntimeList();
  renderPipelinePreview();
  setText("#appVersion", `v${APP_VERSION}`);
  updateCounters();
  drawPreview();
}

init();
