#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ffprobe(file) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type",
    "-show_entries", "format=duration",
    "-of", "json",
    file
  ], { encoding: "utf8" });
  if (result.error) {
    return { ok: false, reason: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, reason: result.stderr || result.stdout || `ffprobe exit ${result.status}` };
  }
  const data = JSON.parse(result.stdout || "{}");
  const streams = Array.isArray(data.streams) ? data.streams : [];
  return {
    ok: true,
    hasVideo: streams.some((item) => item.codec_type === "video"),
    hasAudio: streams.some((item) => item.codec_type === "audio"),
    duration: Number(data.format?.duration || 0)
  };
}

function resolveFromSession(sessionDir, value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.join(sessionDir, value);
}

const sessionDir = process.argv[2];
if (!sessionDir || sessionDir === "--help" || sessionDir === "-h") {
  console.log('Usage: node scripts/qa-production-check.js "PATH_SESSION_OUTPUT"');
  process.exit(sessionDir ? 0 : 2);
}

const root = path.resolve(sessionDir);
if (!fs.existsSync(root)) {
  fail(`session folder not found: ${root}`);
  process.exit();
}

const requiredFolders = ["Video Original", "Clip", "Caption", "Metadata", "XML", "Thumbnail"];
for (const folder of requiredFolders) {
  const target = path.join(root, folder);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    fail(`missing output folder: ${folder}`);
  } else {
    ok(`folder exists: ${folder}`);
  }
}

const logPath = path.join(root, "render-log.json");
if (!fs.existsSync(logPath)) {
  fail("render-log.json is missing");
  process.exit();
}
ok("render-log.json exists");

const log = readJson(logPath);
const manifest = log.manifest || log;
const requested = Number(log.requested_count || manifest.requested_clip_count || 0);
const validCount = Number(log.valid_mp4_count || manifest.valid_mp4_count || 0);
const renderedCount = Number(log.rendered_count || manifest.rendered_count || 0);
const outputs = Array.isArray(log.outputs) && log.outputs.length
  ? log.outputs
  : (manifest.outputs || []).map((item) => ({
      title: item.title,
      mp4: item.video,
      ass: item.subtitle,
      srt: item.subtitleSrt,
      json: item.metadata,
      thumbnail: item.thumbnail
    }));

const subtitleValidationRoot = path.join(root, ".cliper-internal", "cache");
const subtitleValidationFiles = fs.existsSync(subtitleValidationRoot)
  ? fs.readdirSync(subtitleValidationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("clip_"))
      .map((entry) => path.join(subtitleValidationRoot, entry.name, "subtitle_validation.json"))
      .filter((file) => fs.existsSync(file))
  : [];

if (!requested) fail("requested_count/requested_clip_count is missing or zero");
if (validCount < requested) fail(`valid_mp4_count ${validCount} is lower than requested_count ${requested}`);
if (renderedCount < requested) fail(`rendered_count ${renderedCount} is lower than requested_count ${requested}`);
if (/^Completed$/i.test(String(log.status || "")) && validCount < requested) {
  fail("status is Completed while valid output count is lower than requested");
}

const clipDir = path.join(root, "Clip");
const metadataDir = path.join(root, "Metadata");
const mp4Files = fs.existsSync(clipDir)
  ? fs.readdirSync(clipDir).filter((name) => name.toLowerCase().endsWith(".mp4"))
  : [];
if (mp4Files.length < requested) fail(`Clip folder has ${mp4Files.length} MP4, requested ${requested}`);

for (const output of outputs) {
  const mp4 = resolveFromSession(root, output.mp4);
  if (!mp4 || !fs.existsSync(mp4)) {
    fail(`MP4 missing for output: ${output.title || "untitled"}`);
    continue;
  }
  if (path.dirname(mp4).toLowerCase() !== clipDir.toLowerCase()) {
    fail(`MP4 not inside Clip folder: ${mp4}`);
  }
  if (/^clip[_ -]?\d+/i.test(path.basename(mp4, ".mp4"))) {
    fail(`filename still uses generic clip naming: ${path.basename(mp4)}`);
  }

  const metadataPath = resolveFromSession(root, output.json);
  const fallbackMetadata = path.join(metadataDir, `${path.basename(mp4, ".mp4")}.json`);
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    if (!fs.existsSync(fallbackMetadata)) {
      fail(`metadata JSON missing for ${path.basename(mp4)}`);
    }
  }

  const probe = ffprobe(mp4);
  if (!probe.ok) {
    fail(`ffprobe failed for ${path.basename(mp4)}: ${probe.reason}`);
    continue;
  }
  if (!probe.hasVideo) fail(`video stream missing: ${path.basename(mp4)}`);
  if (!probe.hasAudio) fail(`audio stream missing: ${path.basename(mp4)}`);
  if (!(probe.duration > 0)) fail(`duration invalid: ${path.basename(mp4)}`);
}

const captionedOutputs = outputs.filter((output) => {
  const ass = resolveFromSession(root, output.ass);
  return ass && fs.existsSync(ass);
});
if (captionedOutputs.length && subtitleValidationFiles.length < captionedOutputs.length) {
  fail(`subtitle validation missing: expected ${captionedOutputs.length}, found ${subtitleValidationFiles.length}`);
}
for (const validationFile of subtitleValidationFiles) {
  const validation = readJson(validationFile);
  if (validation.ok !== true) fail(`subtitle validation failed: ${validationFile}`);
  if (Number(validation.coverage_ratio || 0) < 0.90) fail(`subtitle coverage below 90%: ${validationFile}`);
  if (Array.isArray(validation.errors) && validation.errors.length) fail(`subtitle validation contains errors: ${validation.errors.join("; ")}`);
  if (!(Number(validation.ass_event_count || 0) > 0)) fail(`subtitle ASS event count invalid: ${validationFile}`);
}

if (!process.exitCode) {
  ok(`QA production check passed: requested=${requested}, valid=${validCount}, outputs=${outputs.length}`);
}
