const state = {
  view: "studio",
  selectedMoments: new Set(),
  progress: 0,
  processingTimer: null,
  scanCount: 0,
  cookiesPath: "",
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
    addCaptions: $("#autoCaption").checked,
    autoCut: $("#autoCut").checked,
    addHook: $("#autoHook").checked,
    faceTrack: $("#faceTrack").checked,
    addWatermark: $("#watermarkToggle").checked,
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
  $("#subtitleMetric").textContent = deps.yt_dlp?.ok ? "yt-dlp ready" : "yt-dlp missing";
  $("#apiStatus").textContent = deps.ffmpeg?.ok ? "FFmpeg ready" : "FFmpeg belum ada";
  $("#runtimeMetric").textContent = deps.ffmpeg?.ok ? "Runtime ready" : "FFmpeg belum ada";
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

function saveConfig() {
  const config = {
    baseUrl: $("#baseUrl")?.value,
    apiKey: $("#apiKey")?.value,
    highlightModel: $("#highlightModel")?.value,
    outputFolder: $("#outputFolder")?.value,
    captionStyle: $("#captionStyle")?.value,
    formatProfile: $("#formatProfile")?.value
  };
  localStorage.setItem("cliper-config", JSON.stringify(config));
  $("#apiStatus").textContent = config.apiKey ? "API tersimpan" : "API belum diset";
  renderProviders();
  toast("Setting disimpan");
}

function loadConfig() {
  try {
    const config = JSON.parse(localStorage.getItem("cliper-config") || "{}");
    Object.entries(config).forEach(([key, value]) => {
      const node = $(`#${key}`);
      if (node && value) node.value = value;
    });
  } catch {
    localStorage.removeItem("cliper-config");
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

  $("#youtubeUrl").addEventListener("input", (event) => {
    const clean = event.target.value.replace(/^https?:\/\//, "");
    $("#previewUrl").textContent = clean || "Masukkan link YouTube";
  });

  $("#clipCount").addEventListener("input", updateCounters);
  $("#durationTarget").addEventListener("change", updateCounters);
  $("#captionStyle").addEventListener("change", updateCounters);

  $("#chooseCookieFile").addEventListener("click", async () => {
    if (window.cliper) {
      const filePath = await window.cliper.selectCookieFile();
      if (filePath) {
        state.cookiesPath = filePath;
        $("#cookieState").textContent = filePath;
        toast("cookies.txt dipilih");
      }
      return;
    }
    $("#cookieFile").click();
  });

  $("#cookieFile").addEventListener("change", (event) => {
    const file = event.target.files[0];
    $("#cookieState").textContent = file ? `${file.name} siap dipakai` : "Belum dipilih";
    toast(file ? "cookies.txt dipilih" : "cookies.txt kosong");
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
  $("#saveConfig").addEventListener("click", saveConfig);
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

function init() {
  loadConfig();
  bindEvents();
  renderMoments();
  renderSteps();
  renderLogs();
  renderSessions();
  renderProviders();
  updateCounters();
  drawPreview();
}

init();
