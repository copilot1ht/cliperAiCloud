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
  lastAnalysis: null,
  previewImageUrl: "",
  apiLastTestedAt: "",
  apiLastLatencyMs: 0,
  apiLastResponse: "",
  logLines: [
    "[ready] Menunggu link YouTube"
  ]
};

let momentBank = [];

const steps = [
  "Validasi YouTube URL dan cookies",
  "Ambil subtitle atau transkrip fallback",
  "Skor hook, retention, dan clarity",
  "Download segmen terpilih",
  "Auto crop 9:16 dan face tracking",
  "Burn-in caption, hook, watermark",
  "Tulis metadata dan export MP4"
];

let sessions = [];

const providerTasks = [
  ["Highlight finder", "Hook, retention, virality"],
  ["Caption maker", "Subtitle cleanup"],
  ["Hook maker", "Opening text + TTS script"],
  ["Title maker", "Title, hashtag, description"]
];

const aiProviderDefaults = {
  ytclip: { label: "YTClip AI", baseUrl: "https://ai-api.ytclip.org/v1", model: "ytclip-highlight-v1", requiresKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", requiresKey: true },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", requiresKey: true },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", requiresKey: true },
  custom: { label: "Custom / OpenAI Compatible", baseUrl: "", model: "", requiresKey: true },
  local: { label: "Local Heuristic", baseUrl: "", model: "local-heuristic", requiresKey: false }
};

const enhancementControls = [
  ["smartCropToggle", "Smart crop"],
  ["dynamicZoomToggle", "Dynamic zoom"],
  ["pipelineFaceTrack", "Face tracking"],
  ["pipelineCaption", "Auto caption"],
  ["pipelineBurnSubtitle", "Burn subtitle"],
  ["pipelineHook", "Hook intro"],
  ["autoCut", "Auto cut"],
  ["metadataToggle", "Judul & hashtag"],
  ["ttsHookToggle", "Hook TTS"],
  ["audioEnhanceToggle", "Audio enhancement"],
  ["colorEnhanceToggle", "Color enhancement"],
  ["creditTextToggle", "Credit text"],
  ["logoOverlayToggle", "Logo overlay"],
  ["pipelineWatermark", "Watermark"],
  ["thumbnailPreviewToggle", "Thumbnail preview"]
];

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
  return momentBank.filter((item) => state.selectedMoments.has(item.id));
}

function updateCounters() {
  const count = selectedMoments().length;
  $("#clipCounter").textContent = `${count} clip dipilih`;
  $("#previewDuration").textContent = state.lastAnalysis
    ? `${$("#clipCount").value || 0} clip - ${$("#durationTarget").value}`
    : "Belum dianalisa";
  $("#captionMetric").textContent = state.lastAnalysis ? ($("#captionStyle") ? $("#captionStyle").value : "Caption aktif") : "Belum diproses";
}

function renderMoments() {
  const grid = $("#momentGrid");
  if (momentBank.length === 0) {
    grid.innerHTML = `
      <div class="empty-state wide">
        <strong>Masukkan link YouTube untuk menganalisa moment terbaik.</strong>
        <span>Moment AI hanya muncul dari metadata, subtitle, chapter, atau scoring real setelah proses analyze selesai.</span>
      </div>
    `;
    updateCounters();
    return;
  }
  grid.innerHTML = momentBank
    .map((item) => {
      const checked = state.selectedMoments.has(item.id);
      return `
        <article class="moment-card ${checked ? "selected" : ""}">
          <div class="phone-thumb" ${item.previewThumbnail ? `style="background-image: linear-gradient(180deg, rgba(23,32,38,.1), rgba(23,32,38,.86)), url('${item.previewThumbnail}')"` : ""}>
            <span>${item.type}</span>
            <strong>${item.score}</strong>
            <em>${item.duration}</em>
          </div>
          <div class="moment-body">
            <div class="card-meta">
              <span>${item.time}</span>
              <span class="score">${item.score}/100</span>
            </div>
            <h3>${item.title}</h3>
            <p>${item.transcript}</p>
            <div class="suggestion">${item.titleSuggestion}</div>
            <label class="toggle-row">
              <input type="checkbox" ${checked ? "checked" : ""} data-toggle-moment="${item.id}" />
              Pilih untuk render
            </label>
          </div>
        </article>
      `;
    })
    .join("");
  updateCounters();
}

function collectPayload() {
  return {
    url: $("#youtubeUrl").value.trim(),
    clipCount: Number($("#clipCount").value || 5),
    durationTarget: $("#durationTarget").value,
    subtitleLang: $("#subtitleLang").value,
    scoreMode: $("#scoreMode").value,
    cookiesPath: state.cookiesPath,
    outputFolder: $("#outputFolder")?.value || "outputs/clips",
    projectName: $("#projectName")?.value || "Cliper YouTube AI Studio",
    ffmpegPath: $("#ffmpegPath")?.value || "",
    ffprobePath: $("#ffprobePath")?.value || "",
    resolutionProfile: $("#resolutionProfile")?.value,
    crfProfile: $("#crfProfile")?.value,
    fpsProfile: $("#fpsProfile")?.value,
    enableUpscale: $("#upscaleToggle")?.checked,
    upscaleMethod: $("#upscaleMethod")?.value,
    gpuAcceleration: $("#gpuToggle")?.checked,
    activeEncoder: $("#activeEncoder")?.textContent,
    smartCrop: $("#smartCropToggle")?.checked ?? true,
    dynamicZoom: $("#dynamicZoomToggle")?.checked ?? false,
    addCaptions: fieldValue("pipelineCaption", false),
    burnSubtitle: fieldValue("pipelineBurnSubtitle", false),
    autoCut: fieldValue("autoCut", false),
    addHook: fieldValue("pipelineHook", false),
    addTtsHook: $("#ttsHookToggle")?.checked ?? false,
    hookDuration: $("#hookDuration")?.value,
    faceTrack: fieldValue("pipelineFaceTrack", false),
    audioEnhance: $("#audioEnhanceToggle")?.checked ?? false,
    colorEnhance: $("#colorEnhanceToggle")?.checked ?? false,
    creditText: $("#creditTextToggle")?.checked ?? false,
    logoOverlay: $("#logoOverlayToggle")?.checked ?? false,
    exportThumbnailPreview: $("#thumbnailPreviewToggle")?.checked ?? true,
    addWatermark: fieldValue("pipelineWatermark", false),
    watermarkText: $("#watermarkText")?.value,
    watermarkOpacity: $("#watermarkOpacity")?.value,
    watermarkPosition: $("#watermarkPosition")?.value,
    writeMetadata: fieldValue("metadataToggle", false),
    metadataToggle: fieldValue("metadataToggle", false),
    providerType: $("#providerType")?.value,
    baseUrl: $("#baseUrl")?.value,
    apiKey: $("#apiKey")?.value,
    highlightModel: $("#highlightModel")?.value,
    captionStyle: $("#captionStyle")?.value,
    formatProfile: $("#formatProfile")?.value
  };
}

function selectedMomentPayload() {
  return selectedMoments().map((item) => ({
    id: item.id,
    title: item.title,
    start: item.start,
    end: item.end,
    duration: Number(item.durationSeconds || String(item.duration || "").replace(/[^\d.]/g, "") || 30),
    time: item.time,
    score: item.score,
    type: item.type,
    transcript: item.transcript,
    titleSuggestion: item.titleSuggestion
  }));
}

function renderSteps() {
  const current = Math.min(steps.length - 1, Math.floor(state.progress / (100 / steps.length)));
  $("#stepList").innerHTML = steps
    .map((step, index) => {
      const className = state.progress >= 100 || index < current ? "done" : index === current ? "active" : "";
      return `<li class="${className}"><span class="step-dot"></span><span>${step}</span></li>`;
    })
    .join("");
  $("#progressBar").style.width = `${state.progress}%`;
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
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function activeEnhancements() {
  return enhancementControls.map(([id, label]) => ({
    id,
    label,
    enabled: Boolean($(`#${id}`)?.checked)
  }));
}

function estimateRenderSeconds() {
  const clips = Math.max(1, selectedMoments().length || Number($("#clipCount")?.value || 1));
  const avgDuration = selectedMoments().length
    ? selectedMoments().reduce((total, item) => total + Number(item.durationSeconds || 35), 0) / selectedMoments().length
    : 40;
  let multiplier = 1.2;
  if ($("#pipelineFaceTrack")?.checked) multiplier += 0.65;
  if ($("#dynamicZoomToggle")?.checked) multiplier += 0.2;
  if ($("#pipelineCaption")?.checked) multiplier += 0.35;
  if ($("#audioEnhanceToggle")?.checked) multiplier += 0.15;
  if ($("#colorEnhanceToggle")?.checked) multiplier += 0.15;
  if ($("#pipelineHook")?.checked) multiplier += 0.1;
  return Math.ceil(clips * avgDuration * multiplier);
}

function renderPipelinePreview() {
  const summary = $("#pipelineSummary");
  if (!summary) return;
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
    ["Local AI Upscaler", deps?.upscaler?.ok ? "Ready" : "Opsional", deps?.upscaler?.ok]
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
  return payload.providerType !== "local" && Boolean(payload.apiKey && payload.baseUrl && payload.model);
}

let metadataTimer = null;
let metadataUrl = "";

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
  metadataUrl = url;
  pushLog(`[metadata] fetching metadata for ${url}`);
  setText("#previewTitle", "Memuat metadata...");
  setText("#previewUrl", url);
  try {
    const payload = {
      ...collectPayload(),
      useMomentAI: isAiEnabled(),
      metadataOnly: true,
      clipCount: 0,
      durationTarget: "20-35 detik"
    };
    const result = await window.cliper.analyze(payload);
    if (result.type === "error") {
      setText("#previewTitle", "Metadata gagal");
      setText("#subtitleMetric", "Metadata error");
      pushLog(`[metadata] gagal: ${result.message}`);
      return;
    }
    const data = result.result;
    setText("#previewTitle", data.video?.title || "Tidak ada judul");
    setText("#previewUrl", data.video?.webpage_url || url);
    setText("#subtitleMetric", data.video?.subtitle_language || "No subtitle");
    state.previewImageUrl = data.video?.thumbnail || "";
    drawPreview();
    state.lastAnalysis = null;
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
      (session) => `
        <article class="session-card">
          <div class="session-thumb">
            <span>${session.clips}</span>
          </div>
          <div>
            <h3>${session.name}</h3>
            <p>${session.clips} MP4 - ${session.date} - ${session.size}</p>
          </div>
          <span class="status-chip">${session.status}</span>
          <button class="secondary-action">Buka folder</button>
          <button class="secondary-action">Upload</button>
        </article>
      `
    )
    .join("");
}

function renderProviders() {
  const providerType = $("#providerType")?.value || "local";
  const provider = aiProviderDefaults[providerType] || aiProviderDefaults.local;
  const baseUrl = $("#baseUrl")?.value?.trim();
  const model = $("#highlightModel")?.value?.trim();
  const hasApiKey = Boolean($("#apiKey")?.value?.trim());
  const ready = providerType === "local" || Boolean(baseUrl && (!provider.requiresKey || hasApiKey) && model);
  $("#providerList").innerHTML = providerTasks
    .map(
      ([task, note]) => `
        <article class="provider-item">
          <div>
            <strong>${task}</strong>
            <span>${note} · ${provider.label}</span>
          </div>
          <em>${ready ? model : "Belum dikonfigurasi"}</em>
        </article>
      `
    )
    .join("");
}

function providerPayload() {
  const providerType = $("#providerType")?.value || "local";
  const modelValue = $("#highlightModel")?.value?.trim();
  return {
    providerType,
    baseUrl: $("#baseUrl")?.value?.trim(),
    apiKey: $("#apiKey")?.value?.trim(),
    model: modelValue || (providerType === "local" ? "local-heuristic" : "gpt-4.1-mini"),
    timeoutMs: 15000
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
}

function providerErrorMessage(status, payload) {
  const text = String(status || "Test API gagal");
  if (/invalid|unauthorized|401|forbidden|api key/i.test(text)) {
    return `Invalid API key - pastikan key cocok untuk ${aiProviderDefaults[payload.providerType]?.label || payload.providerType}`;
  }
  if (/timeout|timed out/i.test(text)) {
    return "Connection Timeout - cek koneksi atau Base URL";
  }
  return text;
}

function setModelOptions(models = []) {
  const list = $("#highlightModelOptions");
  if (!list) return;
  list.innerHTML = models.map((model) => `<option value="${model}"></option>`).join("");
}

function applyProviderDefaults(force = false) {
  const providerType = $("#providerType")?.value || "local";
  const preset = aiProviderDefaults[providerType] || aiProviderDefaults.local;
  const base = $("#baseUrl");
  const key = $("#apiKey");
  const model = $("#highlightModel");
  const isKnownDefault = Object.values(aiProviderDefaults).some((item) => item.baseUrl && item.baseUrl === base?.value);
  if (base && (force || !base.value || isKnownDefault)) {
    base.value = preset.baseUrl;
  }
  if (model && (force || !model.value)) {
    model.value = preset.model;
  }
  if (key) {
    key.disabled = providerType === "local";
    key.placeholder = providerType === "local" ? "Local heuristic tidak memakai API key" : "Masukkan API key";
  }
  if (base) {
    base.disabled = providerType === "local";
  }
  setProviderStatus(providerType === "local" ? "Local heuristic ready" : "Belum dites", providerType === "local");
  renderProviders();
}

async function loadProviderModels(options = {}) {
  const payload = providerPayload();
  const preset = aiProviderDefaults[payload.providerType] || aiProviderDefaults.openai;
  if (payload.providerType === "local") {
    const models = ["local-heuristic", "local-transcript-score", "local-fast"];
    setModelOptions(models);
    $("#highlightModel").value = payload.model || "local-heuristic";
    setProviderStatus("Local heuristic siap", true);
    pushLog(`[ai] Local heuristic mode aktif`);
    renderProviders();
    if (!options.silent) toast("Local heuristic ready");
    return { ok: true, providerType: "local", models, suggestedModel: payload.model || "local-heuristic", status: "Local ready" };
  }
  if (preset.requiresKey && !payload.apiKey) {
    setProviderStatus("API key kosong", false);
    toast("API key belum diisi");
    return null;
  }
  if (!window.cliper?.loadModels) {
    const fallback = preset.model ? [preset.model] : [];
    setModelOptions(fallback);
    if (fallback[0]) $("#highlightModel").value = fallback[0];
    setProviderStatus("Load Models tersedia di .exe", false);
    toast("Buka via .exe untuk Load Models");
    return null;
  }
  setProviderStatus("Loading models...", true);
  const result = await window.cliper.loadModels(payload);
  if (!result?.ok) {
    const status = result?.status || "Load Models gagal";
    setProviderStatus(status, false);
    pushLog(`[ai] Load Models gagal: provider=${payload.providerType} baseUrl=${payload.baseUrl} model=${payload.model} status=${status}`);
    toast(status);
    renderProviders();
    return result;
  }
  const models = Array.isArray(result.models) ? result.models : [];
  setModelOptions(models);
  if (result.suggestedModel) {
    $("#highlightModel").value = result.suggestedModel;
  }
  const status = `${result.status || "Connected"} - ${models.length || 0} model`;
  setProviderStatus(status, true);
  setText("#apiStatus", "AI connected");
  pushLog(`[ai] ${preset.label} connected, ${models.length} models loaded, selected=${$("#highlightModel").value || "-"}`);
  renderProviders();
  if (!options.silent) toast("Models loaded");
  return result;
}

async function testProvider(options = {}) {
  const payload = providerPayload();
  const preset = aiProviderDefaults[payload.providerType] || aiProviderDefaults.openai;
  if (payload.providerType === "local") {
    setProviderStatus("Local heuristic aktif", true);
    setText("#apiStatus", "Local heuristic active");
    pushLog(`[ai] Local heuristic mode selected, no network test required`);
    if (!options.silent) toast("Local heuristic aktif");
    return { ok: true, status: "Local heuristic active", response: "OK", usage: {} };
  }
  if (preset.requiresKey && !payload.apiKey) {
    setProviderStatus("API key kosong", false);
    toast("API key belum diisi");
    return null;
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
  setProviderStatus(`Connected ✓ ${payload.providerType}`, true);
  setText("#apiStatus", `Connected ✓ ${payload.providerType}`);
  pushLog(`[ai] Test API response received in ${duration}ms, ${usage}`);
  pushLog(`[ai] provider=${payload.providerType} model=${payload.model} response=${responseText}`);
  state.apiLastLatencyMs = duration;
  state.apiLastResponse = responseText;
  if (!options.silent) toast("Test API sukses");
  await saveConfig({ silent: true });
  return { ...response, latencyMs: duration };
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
  ctx.fillText("CLIPER YOUTUBE AI STUDIO", 64, 120);
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

  clearInterval(state.processingTimer);
  state.progress = 0;
  $("#progressBar").style.width = "0%";
  $("#jobBadge").textContent = "Analyzing";
  pushLog(`[analyze] mulai analisa nyata: ${$("#youtubeUrl").value}`);
  setView("render");
  const result = await window.cliper.analyze(collectPayload());
  if (result.type === "error") {
    $("#jobBadge").textContent = "Error";
    pushLog(`[error] ${result.message}`);
    toast(result.message);
    return;
  }

  const data = result.result;
  state.lastAnalysis = data;
  if (data.video?.used_cookies) {
    await markCookiesUsed();
    pushLog("[cookies] digunakan otomatis setelah video meminta login/age verification");
  }
  momentBank = (data.moments || []).map((item, index) => ({
    ...item,
    id: item.id || index + 1,
    durationSeconds: Number(item.duration || 0),
    duration: `${Math.round(Number(item.duration || 0))}s`,
    previewThumbnail: item.preview_thumbnail_path || data.video?.thumbnail || "",
    titleSuggestion: item.titleSuggestion || item.title
  }));
  state.selectedMoments = new Set(momentBank.map((item) => item.id));
  $("#previewTitle").textContent = data.video?.title || "YouTube video";
  $("#previewUrl").textContent = data.video?.webpage_url || $("#youtubeUrl").value;
  $("#subtitleMetric").textContent = data.video?.subtitle_language || "No subtitle";
  $("#previewScore").textContent = momentBank[0]?.score || "-";
  state.previewImageUrl = data.video?.thumbnail || "";
  drawPreview();
  $("#jobBadge").textContent = "Ready";
  renderMoments();
  renderPipelinePreview();
  setView("moments");
  toast("Moment nyata siap dipilih");
}

async function startProcessing() {
  const clips = selectedMoments();
  if (clips.length === 0) {
    toast("Pilih minimal 1 moment");
    return;
  }

  if (window.cliper) {
    clearInterval(state.processingTimer);
    state.progress = 0;
    state.renderStartedAt = Date.now();
    updateRenderStats({ progress: 0, stage: "Starting", clipIndex: 1, totalClips: clips.length });
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
    $("#jobBadge").textContent = "Complete";
    const outputCount = result.result?.outputs?.length || clips.length;
    sessions.unshift({
      name: result.result?.manifest?.title || "YouTube clip session",
      clips: outputCount,
      date: "Baru saja",
      status: "Siap upload",
      size: result.result?.sessionDir || "Lihat folder"
    });
    renderSessions();
    pushLog(`[done] output: ${result.result?.sessionDir || "-"}`);
    toast("Render selesai");
    setView("outputs");
    return;
  }

  toast("Buka via .exe untuk render real");
}

function buildConfig() {
  const config = {
    providerType: fieldValue("providerType", "local"),
    baseUrl: fieldValue("baseUrl", ""),
    apiKey: fieldValue("apiKey"),
    highlightModel: fieldValue("highlightModel", "local-heuristic"),
    providerStatus: $("#providerStatusText")?.textContent || "Local heuristic ready",
    apiStatus: $("#apiStatus")?.textContent || "Local heuristic active",
    apiLastTestedAt: state.apiLastTestedAt || "",
    apiLastLatencyMs: state.apiLastLatencyMs || 0,
    apiLastResponse: state.apiLastResponse || "",
    outputFolder: fieldValue("outputFolder", "outputs/clips"),
    projectName: fieldValue("projectName", "Cliper YouTube AI Studio"),
    ffmpegPath: fieldValue("ffmpegPath", ""),
    ffprobePath: fieldValue("ffprobePath", ""),
    overwriteExisting: fieldValue("overwriteExisting", false),
    autoRename: fieldValue("autoRename", true),
    createProjectFolder: fieldValue("createProjectFolder", true),
    deleteTempAfterExport: fieldValue("deleteTempAfterExport", true),
    formatProfile: fieldValue("formatProfile", "9:16 YouTube Shorts"),
    resolutionProfile: fieldValue("resolutionProfile", "1080p"),
    upscaleToggle: fieldValue("upscaleToggle", false),
    upscaleMethod: fieldValue("upscaleMethod", "FFmpeg Lanczos"),
    crfProfile: fieldValue("crfProfile", "23"),
    fpsProfile: fieldValue("fpsProfile", "Same as source"),
    captionStyle: fieldValue("captionStyle", "Karaoke bold"),
    subtitleBurnToggle: fieldValue("subtitleBurnToggle", false),
    hookOpeningToggle: fieldValue("hookOpeningToggle", false),
    hookDuration: fieldValue("hookDuration", "3 seconds"),
    smartCropToggle: fieldValue("smartCropToggle", true),
    dynamicZoomToggle: fieldValue("dynamicZoomToggle", false),
    pipelineFaceTrack: fieldValue("pipelineFaceTrack", false),
    pipelineCaption: fieldValue("pipelineCaption", false),
    pipelineBurnSubtitle: fieldValue("pipelineBurnSubtitle", false),
    pipelineHook: fieldValue("pipelineHook", false),
    ttsHookToggle: fieldValue("ttsHookToggle", false),
    audioEnhanceToggle: fieldValue("audioEnhanceToggle", false),
    colorEnhanceToggle: fieldValue("colorEnhanceToggle", false),
    creditTextToggle: fieldValue("creditTextToggle", false),
    logoOverlayToggle: fieldValue("logoOverlayToggle", false),
    pipelineWatermark: fieldValue("pipelineWatermark", false),
    thumbnailPreviewToggle: fieldValue("thumbnailPreviewToggle", false),
    watermarkEnabled: fieldValue("watermarkEnabled", false),
    watermarkInOutput: fieldValue("watermarkInOutput", false),
    watermarkText: fieldValue("watermarkText"),
    watermarkOpacity: fieldValue("watermarkOpacity", "68"),
    watermarkPosition: fieldValue("watermarkPosition", "Top right"),
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
  state.config = config;
  setValue("#providerType", config.providerType || "local");
  setValue("#baseUrl", config.baseUrl || "");
  setValue("#apiKey", config.apiKey || "");
  setValue("#highlightModel", config.highlightModel || "local-heuristic");
  setValue("#outputFolder", config.outputFolder || "outputs/clips");
  setValue("#projectName", config.projectName || "Cliper YouTube AI Studio");
  setValue("#ffmpegPath", config.ffmpegPath || "");
  setValue("#ffprobePath", config.ffprobePath || "");
  setValue("#formatProfile", config.formatProfile || "9:16 YouTube Shorts");
  state.apiLastTestedAt = config.apiLastTestedAt || "";
  state.apiLastLatencyMs = config.apiLastLatencyMs || 0;
  state.apiLastResponse = config.apiLastResponse || "";
  setValue("#resolutionProfile", config.resolutionProfile || "1080p");
  setValue("#upscaleToggle", config.upscaleToggle ?? true);
  setValue("#upscaleMethod", config.upscaleMethod || "FFmpeg Lanczos");
  setValue("#crfProfile", config.crfProfile || "23");
  setValue("#fpsProfile", config.fpsProfile || "Same as source");
  setValue("#captionStyle", config.captionStyle || "Karaoke bold");
  setValue("#subtitleBurnToggle", config.subtitleBurnToggle ?? false);
  setValue("#hookOpeningToggle", config.hookOpeningToggle ?? false);
  setValue("#hookDuration", config.hookDuration || "3 seconds");
  setValue("#smartCropToggle", config.smartCropToggle ?? true);
  setValue("#dynamicZoomToggle", config.dynamicZoomToggle ?? false);
  setValue("#pipelineFaceTrack", config.pipelineFaceTrack ?? false);
  setValue("#pipelineCaption", config.pipelineCaption ?? false);
  setValue("#pipelineBurnSubtitle", config.pipelineBurnSubtitle ?? false);
  setValue("#pipelineHook", config.pipelineHook ?? false);
  setValue("#ttsHookToggle", config.ttsHookToggle ?? false);
  setValue("#audioEnhanceToggle", config.audioEnhanceToggle ?? false);
  setValue("#colorEnhanceToggle", config.colorEnhanceToggle ?? false);
  setValue("#creditTextToggle", config.creditTextToggle ?? false);
  setValue("#logoOverlayToggle", config.logoOverlayToggle ?? false);
  setValue("#pipelineWatermark", config.pipelineWatermark ?? false);
  setValue("#thumbnailPreviewToggle", config.thumbnailPreviewToggle ?? false);
  setValue("#watermarkEnabled", config.watermarkEnabled ?? false);
  setValue("#watermarkInOutput", config.watermarkInOutput ?? false);
  setValue("#watermarkText", config.watermarkText || "");
  setValue("#watermarkOpacity", config.watermarkOpacity || "68");
  setValue("#watermarkPosition", config.watermarkPosition || "Top right");
  setValue("#gpuToggle", config.gpuToggle ?? false);
  setValue("#overwriteExisting", config.overwriteExisting ?? false);
  setValue("#autoRename", config.autoRename ?? true);
  setValue("#createProjectFolder", config.createProjectFolder ?? true);
  setValue("#deleteTempAfterExport", config.deleteTempAfterExport ?? true);
  state.cookiesInfo = normalizeCookiesInfo(config);
  state.cookiesPath = state.cookiesInfo?.path || "";
  setText("#apiStatus", config.providerType === "local" ? "Local heuristic active" : config.apiKey ? "API tersimpan" : "API belum diset");
  applyProviderDefaults(false);
  renderProviders();
  renderCookiesManager();
}

async function saveConfig(options = {}) {
  const config = buildConfig();
  state.config = config;
  localStorage.setItem("cliper-config", JSON.stringify(config));
  if (window.cliper?.saveConfig) {
    try {
      await window.cliper.saveConfig(config);
    } catch (error) {
      pushLog(`[config] gagal menyimpan config.json: ${error.message}`);
    }
  }
  setText("#apiStatus", config.apiKey ? "API tersimpan" : "API belum diset");
  renderProviders();
  renderCookiesManager();
  if (!options.silent) toast("Setting disimpan");
  if (state.config.providerType === "local") {
    setText("#apiStatus", "Local heuristic active");
  }
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
    $("#previewUrl").textContent = text.trim();
    scheduleMetadataFetch();
    toast("URL ditempel");
  });

  $("#clipCount").addEventListener("input", updateCounters);
  $("#clipCount").addEventListener("input", renderPipelinePreview);
  $("#durationTarget").addEventListener("change", updateCounters);
  $("#durationTarget").addEventListener("change", renderPipelinePreview);
  $("#captionStyle").addEventListener("change", updateCounters);
  enhancementControls.forEach(([id]) => {
    const node = $(`#${id}`);
    if (node) node.addEventListener("change", renderPipelinePreview);
  });
  [
    ["subtitleBurnToggle", "pipelineBurnSubtitle"],
    ["hookOpeningToggle", "pipelineHook"],
    ["watermarkInOutput", "pipelineWatermark"]
  ].forEach(([sourceId, targetId]) => {
    const source = $(`#${sourceId}`);
    const target = $(`#${targetId}`);
    if (source && target) {
      source.addEventListener("change", () => {
        target.checked = source.checked;
        renderPipelinePreview();
      });
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
  $("#processSelected").addEventListener("click", startProcessing);

  $("#momentGrid").addEventListener("change", (event) => {
    const id = Number(event.target.dataset.toggleMoment);
    if (!id) return;
    if (event.target.checked) {
      state.selectedMoments.add(id);
    } else {
      state.selectedMoments.delete(id);
    }
    renderMoments();
  });

  $("#selectAllButton").addEventListener("click", () => {
    const allSelected = state.selectedMoments.size === momentBank.length;
    state.selectedMoments = new Set(allSelected ? [] : momentBank.map((item) => item.id));
    $("#selectAllButton").textContent = allSelected ? "Pilih semua" : "Kosongkan";
    renderMoments();
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
    $("#youtubeUrl").value = "";
    $("#previewUrl").textContent = "Masukkan link YouTube";
    $("#previewTitle").textContent = "Belum ada video";
    $("#previewScore").textContent = "-";
    state.previewImageUrl = "";
    $("#clipCount").value = 6;
    state.lastAnalysis = null;
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
  $("#providerType").addEventListener("change", () => {
    applyProviderDefaults(true);
    renderPipelinePreview();
  });
  $("#baseUrl").addEventListener("input", renderProviders);
  $("#apiKey").addEventListener("input", renderProviders);
  $("#toggleApiKeyVisibility").addEventListener("click", () => {
    const input = $("#apiKey");
    const button = $("#toggleApiKeyVisibility");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.classList.toggle("active", show);
    button.title = show ? "Sembunyikan API key" : "Tampilkan API key";
  });
  $("#highlightModel").addEventListener("input", renderProviders);
  $("#loadModelsButton").addEventListener("click", () => loadProviderModels());
  $("#loadModelsButtonSecondary").addEventListener("click", () => loadProviderModels());
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
  $("#openRuntimeGuide").addEventListener("click", () => {
    const url = "https://github.com/yt-dlp/yt-dlp#dependencies";
    if (window.cliper?.openExternal) {
      window.cliper.openExternal(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
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
        pushLog(`[${String(Math.round(state.progress)).padStart(3, "0")}%] ${event.message || event.stage}`);
        updateRenderStats(event);
        renderSteps();
      } else if (event.type === "log") {
        pushLog(event.message);
      } else if (event.type === "error") {
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
  updateCounters();
  drawPreview();
}

init();
