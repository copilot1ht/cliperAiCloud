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
  lastAnalysis: null,
  previewImageUrl: "",
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
    resolutionProfile: $("#resolutionProfile")?.value,
    crfProfile: $("#crfProfile")?.value,
    fpsProfile: $("#fpsProfile")?.value,
    enableUpscale: $("#upscaleToggle")?.checked,
    upscaleMethod: $("#upscaleMethod")?.value,
    gpuAcceleration: $("#gpuToggle")?.checked,
    activeEncoder: $("#activeEncoder")?.textContent,
    addCaptions: $("#subtitleBurnToggle")?.checked ?? $("#autoCaption").checked,
    autoCut: $("#autoCut").checked,
    addHook: $("#hookOpeningToggle")?.checked ?? $("#autoHook").checked,
    hookDuration: $("#hookDuration")?.value,
    faceTrack: $("#faceTrack").checked,
    addWatermark: $("#watermarkInOutput")?.checked ?? $("#watermarkToggle").checked,
    watermarkText: $("#watermarkText")?.value,
    watermarkOpacity: $("#watermarkOpacity")?.value,
    watermarkPosition: $("#watermarkPosition")?.value,
    writeMetadata: $("#metadataToggle").checked,
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
  const baseUrl = $("#baseUrl")?.value?.trim();
  const model = $("#highlightModel")?.value?.trim();
  const hasApiKey = Boolean($("#apiKey")?.value?.trim());
  $("#providerList").innerHTML = providerTasks
    .map(
      ([task, note]) => `
        <article class="provider-item">
          <div>
            <strong>${task}</strong>
            <span>${note}</span>
          </div>
          <em>${baseUrl && hasApiKey ? `${model || "Model belum diisi"}` : "Belum dikonfigurasi"}</em>
        </article>
      `
    )
    .join("");
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
    baseUrl: fieldValue("baseUrl", "https://api.openai.com/v1"),
    apiKey: fieldValue("apiKey"),
    highlightModel: fieldValue("highlightModel", "gpt-4.1-mini"),
    outputFolder: fieldValue("outputFolder", "outputs/clips"),
    formatProfile: fieldValue("formatProfile", "9:16 YouTube Shorts"),
    resolutionProfile: fieldValue("resolutionProfile", "1080p"),
    upscaleToggle: fieldValue("upscaleToggle", true),
    upscaleMethod: fieldValue("upscaleMethod", "FFmpeg Lanczos"),
    crfProfile: fieldValue("crfProfile", "23"),
    fpsProfile: fieldValue("fpsProfile", "Same as source"),
    captionStyle: fieldValue("captionStyle", "Karaoke bold"),
    subtitleBurnToggle: fieldValue("subtitleBurnToggle", true),
    hookOpeningToggle: fieldValue("hookOpeningToggle", true),
    hookDuration: fieldValue("hookDuration", "3 seconds"),
    watermarkEnabled: fieldValue("watermarkEnabled", false),
    watermarkInOutput: fieldValue("watermarkInOutput", false),
    watermarkText: fieldValue("watermarkText"),
    watermarkOpacity: fieldValue("watermarkOpacity", "68"),
    watermarkPosition: fieldValue("watermarkPosition", "Top right"),
    gpuToggle: fieldValue("gpuToggle", true),
    cookies_path: state.cookiesPath || "",
    cookies_last_import: state.cookiesInfo?.importedAt || "",
    cookies_last_test: state.cookiesInfo?.lastTest || "",
    cookies_last_used: state.cookiesInfo?.lastUsed || "",
    cookies_status: state.cookiesInfo?.status || "",
    cookies_test_status: state.cookiesInfo?.testStatus || "",
    cookies_meta: state.cookiesInfo
  };
  return config;
}

function applyConfig(config = {}) {
  state.config = config;
  setValue("#baseUrl", config.baseUrl || "https://api.openai.com/v1");
  setValue("#apiKey", config.apiKey || "");
  setValue("#highlightModel", config.highlightModel || "gpt-4.1-mini");
  setValue("#outputFolder", config.outputFolder || "outputs/clips");
  setValue("#formatProfile", config.formatProfile || "9:16 YouTube Shorts");
  setValue("#resolutionProfile", config.resolutionProfile || "1080p");
  setValue("#upscaleToggle", config.upscaleToggle ?? true);
  setValue("#upscaleMethod", config.upscaleMethod || "FFmpeg Lanczos");
  setValue("#crfProfile", config.crfProfile || "23");
  setValue("#fpsProfile", config.fpsProfile || "Same as source");
  setValue("#captionStyle", config.captionStyle || "Karaoke bold");
  setValue("#subtitleBurnToggle", config.subtitleBurnToggle ?? true);
  setValue("#hookOpeningToggle", config.hookOpeningToggle ?? true);
  setValue("#hookDuration", config.hookDuration || "3 seconds");
  setValue("#watermarkEnabled", config.watermarkEnabled ?? false);
  setValue("#watermarkInOutput", config.watermarkInOutput ?? false);
  setValue("#watermarkText", config.watermarkText || "");
  setValue("#watermarkOpacity", config.watermarkOpacity || "68");
  setValue("#watermarkPosition", config.watermarkPosition || "Top right");
  setValue("#gpuToggle", config.gpuToggle ?? true);
  state.cookiesInfo = normalizeCookiesInfo(config);
  state.cookiesPath = state.cookiesInfo?.path || "";
  setText("#apiStatus", config.apiKey ? "API tersimpan" : "API belum diset");
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
}

async function loadConfig() {
  let config = {};
  try {
    config = JSON.parse(localStorage.getItem("cliper-config") || "{}");
  } catch {
    localStorage.removeItem("cliper-config");
  }
  if (window.cliper?.getConfig) {
    try {
      config = { ...config, ...(await window.cliper.getConfig()) };
    } catch (error) {
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
  if (!window.cliper?.testCookies) {
    toast("Test cookies tersedia di .exe");
    return;
  }
  toast("Testing cookies...");
  setText("#cookiesTestStatus", "Testing cookies...");
  const result = await window.cliper.testCookies({ cookiesPath: state.cookiesPath, url: $("#youtubeUrl")?.value.trim() });
  const data = result.result || {};
  const now = data.testedAt || new Date().toISOString();
  if (result.type === "error" || !data.testOk) {
    const status = data.status || data.reason || result.message || "Cookies expired";
    state.cookiesInfo = { ...(state.cookiesInfo || {}), lastTest: now, testStatus: status, status };
    await saveConfig({ silent: true });
    pushLog(`[cookies] test gagal: ${status}`);
    toast(status === "Login diperlukan" ? "Login diperlukan" : "Cookies expired");
    return;
  }
  state.cookiesInfo = { ...(state.cookiesInfo || {}), lastTest: now, testStatus: "✓ Cookies valid", status: "Cookies Loaded" };
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
  });

  $("#clipCount").addEventListener("input", updateCounters);
  $("#durationTarget").addEventListener("change", updateCounters);
  $("#captionStyle").addEventListener("change", updateCounters);

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
      toast("Folder output dipilih");
    }
  });
  $("#checkDependencyButton").addEventListener("click", scanSubtitles);
  $("#detectGpuButton").addEventListener("click", detectGpu);
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
  $("#testApiButton").addEventListener("click", () => {
    if (!$("#apiKey").value.trim()) {
      $("#apiStatus").textContent = "API key kosong";
      toast("API key belum diisi");
      renderProviders();
      return;
    }
    $("#apiStatus").textContent = "API configured";
    renderProviders();
    state.logLines.push(`[api] endpoint ${$("#baseUrl").value} berhasil divalidasi`);
    renderLogs();
    toast("API berhasil dites");
  });

  if (window.cliper) {
    window.cliper.onWorkerEvent((event) => {
      if (event.type === "progress") {
        state.progress = Number(event.progress || state.progress || 0);
        $("#progressBar").style.width = `${state.progress}%`;
        pushLog(`[${String(Math.round(state.progress)).padStart(3, "0")}%] ${event.message || event.stage}`);
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
  updateCounters();
  drawPreview();
}

init();
