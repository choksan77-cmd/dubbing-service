import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegPath from "ffmpeg-static";
import ytdlp from "yt-dlp-exec";
import { prisma } from "./prisma";
import { getOpenAI } from "./openai";
import { DEFAULT_VOICE, isValidVoice } from "./voices";

const execFileAsync = promisify(execFile);

export const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), "data");

export function jobDir(jobId) {
  return path.join(STORAGE_DIR, "jobs", jobId);
}

function workDir(jobId) {
  return path.join(os.tmpdir(), "dubbing-jobs", jobId);
}

async function updateStatus(jobId, status, extra = {}) {
  await prisma.dubJob.update({ where: { id: jobId }, data: { status, ...extra } });
}

async function downloadSource(job, sourceDir, dir) {
  if (job.sourceType === "upload") {
    const localPath = path.join(dir, job.originalFilename);
    fs.copyFileSync(path.join(sourceDir, job.originalFilename), localPath);
    return localPath;
  }

  const outputTemplate = path.join(dir, "source.%(ext)s");
  await ytdlp(job.sourceUrl, {
    output: outputTemplate,
    format: "mp4/bestvideo+bestaudio/best",
    mergeOutputFormat: "mp4",
  });

  const files = fs.readdirSync(dir).filter((f) => f.startsWith("source."));
  if (files.length === 0) {
    throw new Error("YouTube 다운로드 결과 파일을 찾을 수 없습니다.");
  }
  return path.join(dir, files[0]);
}

async function extractAudio(videoPath, audioPath) {
  await execFileAsync(ffmpegPath, [
    "-y",
    "-nostdin",
    "-i", videoPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-acodec", "pcm_s16le",
    audioPath,
  ], { timeout: 5 * 60 * 1000 });
}

async function transcribe(audioPath) {
  const response = await getOpenAI().audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  return (response.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
}

async function translateSegments(segments, targetLanguage) {
  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You translate subtitle segments into ${targetLanguage}. ` +
          `Return a JSON object {"translations": string[]} with exactly one translated string per input segment, same order, no extra commentary.`,
      },
      {
        role: "user",
        content: JSON.stringify(segments.map((s) => s.text)),
      },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  const translations = parsed.translations || [];

  return segments.map((s, i) => ({
    ...s,
    translatedText: translations[i] || "",
  }));
}

function srtTimestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRest = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRest, 3)}`;
}

function buildSrt(translatedSegments) {
  return translatedSegments
    .map((s, i) => `${i + 1}\n${srtTimestamp(s.start)} --> ${srtTimestamp(s.end)}\n${s.translatedText}\n`)
    .join("\n");
}

async function synthesizeSpeechSegment(text, outputPath, voice) {
  const response = await getOpenAI().audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: isValidVoice(voice) ? voice : DEFAULT_VOICE,
    input: text,
    response_format: "wav",
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseDurationFromOutput(text) {
  const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(text || "");
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// Single-input probe (no filter_complex, no multi-input) — safe on Railway per
// the ffmpeg-hang lesson in muxFinalVideo. Reuses ffmpeg-static instead of
// adding an ffprobe dependency.
async function getMediaDuration(filePath) {
  try {
    const { stderr } = await execFileAsync(
      ffmpegPath,
      ["-y", "-nostdin", "-i", filePath, "-f", "null", "-"],
      { timeout: 60 * 1000 }
    );
    return parseDurationFromOutput(stderr);
  } catch (error) {
    return parseDurationFromOutput(error.stderr);
  }
}

async function normalizeToCanonicalWav(inputPath, outputPath) {
  await execFileAsync(
    ffmpegPath,
    ["-y", "-nostdin", "-i", inputPath, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", outputPath],
    { timeout: 60 * 1000 }
  );
}

// Cap speed-up conservatively so dubbed speech still sounds natural — this
// isn't true mouth-movement lip-sync, so a natural voice pace matters more
// than forcing a tight fit. Segments that would need more than this just
// overflow their slot and later segments drift later (accepted tradeoff).
const MAX_SPEEDUP = 1.3;

function atempoFilterChain(factor) {
  const clamped = Math.min(Math.max(factor, 0.7), MAX_SPEEDUP);
  let stages;
  if (clamped > 2.0) {
    stages = [2.0, clamped / 2.0];
  } else if (clamped < 0.5) {
    stages = [0.5, clamped / 0.5];
  } else {
    stages = [clamped];
  }
  return { chain: stages.map((f) => `atempo=${f.toFixed(3)}`).join(","), applied: clamped };
}

async function applyAtempo(inputPath, outputPath, factor) {
  const { chain, applied } = atempoFilterChain(factor);
  await execFileAsync(
    ffmpegPath,
    ["-y", "-nostdin", "-i", inputPath, "-filter:a", chain, outputPath],
    { timeout: 60 * 1000 }
  );
  return applied;
}

async function generateSilence(durationSeconds, outputPath) {
  if (durationSeconds <= 0.02) return null;
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-nostdin",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
      "-t", durationSeconds.toFixed(3),
      "-c:a", "pcm_s16le",
      outputPath,
    ],
    { timeout: 30 * 1000 }
  );
  return outputPath;
}

// Builds one dubbed-audio track where each segment's speech is time-aligned to
// its original start/end window (sped up via atempo to fit, or silence-padded
// if it's naturally shorter), instead of one continuous whole-text TTS pass.
// TTS calls (network-bound) run with limited concurrency; every ffmpeg call
// stays single-input/sequential per the muxFinalVideo lesson.
async function assembleSegmentAudio(translatedSegments, dir, totalDurationSeconds) {
  const rawPaths = await mapWithConcurrency(translatedSegments, 4, async (seg, i) => {
    const text = (seg.translatedText || "").trim();
    if (!text) return null;
    const rawPath = path.join(dir, `seg_${i}_raw.wav`);
    await synthesizeSpeechSegment(text, rawPath, seg.voice);
    return rawPath;
  });

  const concatEntries = [];
  let cursor = 0;

  for (let i = 0; i < translatedSegments.length; i++) {
    const seg = translatedSegments[i];
    const targetDur = Math.max(0.05, seg.end - seg.start);

    const gapDur = Math.max(0, seg.start - cursor);
    const gapPath = await generateSilence(gapDur, path.join(dir, `gap_${i}.wav`));
    if (gapPath) concatEntries.push(gapPath);

    let actualDur = 0;

    if (rawPaths[i]) {
      const normPath = path.join(dir, `seg_${i}_norm.wav`);
      await normalizeToCanonicalWav(rawPaths[i], normPath);
      const naturalDur = await getMediaDuration(normPath);

      let finalPath = normPath;
      actualDur = naturalDur;

      if (naturalDur > targetDur && naturalDur > 0) {
        // speech is longer than its slot: speed up to fit rather than cutting
        // it off. If clamped at the max 4x, it overflows its slot and later
        // segments simply drift later (accepted tradeoff, see plan).
        const tempoPath = path.join(dir, `seg_${i}_tempo.wav`);
        const appliedFactor = await applyAtempo(normPath, tempoPath, naturalDur / targetDur);
        finalPath = tempoPath;
        actualDur = naturalDur / appliedFactor;
      }

      concatEntries.push(finalPath);
    }

    cursor = seg.start + actualDur;

    if (actualDur < targetDur) {
      // shorter than its slot (or no speech at all): pad with silence rather
      // than slowing speech down, which would sound unnatural.
      const padPath = await generateSilence(targetDur - actualDur, path.join(dir, `pad_${i}.wav`));
      if (padPath) concatEntries.push(padPath);
      cursor = seg.end;
    }
  }

  const trailingPath = await generateSilence(totalDurationSeconds - cursor, path.join(dir, "trailing.wav"));
  if (trailingPath) concatEntries.push(trailingPath);

  if (concatEntries.length === 0) {
    const silencePath = path.join(dir, "silence_full.wav");
    await generateSilence(Math.max(totalDurationSeconds, 0.05), silencePath);
    concatEntries.push(silencePath);
  }

  const listPath = path.join(dir, "concat_list.txt");
  fs.writeFileSync(
    listPath,
    concatEntries.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );

  const dubbedAudioPath = path.join(dir, "dubbed_audio.wav");
  await execFileAsync(
    ffmpegPath,
    ["-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", dubbedAudioPath],
    { timeout: 5 * 60 * 1000 }
  );

  return dubbedAudioPath;
}

async function muxFinalVideo({ videoPath, audioPath, srtPath, outputPath, targetLanguage }) {
  const noSubsPath = outputPath.replace(/\.mp4$/, ".nosubs.mp4");

  await execFileAsync(ffmpegPath, [
    "-y",
    "-nostdin",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    noSubsPath,
  ], { timeout: 5 * 60 * 1000 });

  await execFileAsync(ffmpegPath, [
    "-y",
    "-nostdin",
    "-i", noSubsPath,
    "-i", srtPath,
    "-map", "0",
    "-map", "1",
    "-c", "copy",
    "-c:s", "mov_text",
    "-metadata:s:s:0", `language=${targetLanguage.slice(0, 3)}`,
    "-movflags", "+faststart",
    outputPath,
  ], { timeout: 5 * 60 * 1000 });

  fs.rmSync(noSubsPath, { force: true });
}

// Phase 1: download → transcribe → translate, then pause for user review.
// Ends at status "reviewing" instead of running straight through to done.
export async function runTranscribeAndTranslate(jobId) {
  const job = await prisma.dubJob.findUniqueOrThrow({ where: { id: jobId } });
  const sourceDir = jobDir(jobId);
  fs.mkdirSync(sourceDir, { recursive: true });
  const dir = workDir(jobId);
  fs.mkdirSync(dir, { recursive: true });

  try {
    await updateStatus(jobId, "downloading");
    const videoPath = await downloadSource(job, sourceDir, dir);

    // Persist the source video unconditionally (upload jobs already have a
    // copy under their original filename, but this gives phase 2 one fixed
    // path to rely on regardless of source type) — phase 2 may run long
    // after this function's temp workDir is gone.
    const persistentVideoPath = path.join(sourceDir, "source.mp4");
    fs.copyFileSync(videoPath, persistentVideoPath);

    const audioPath = path.join(dir, "audio.wav");
    await extractAudio(videoPath, audioPath);

    await updateStatus(jobId, "transcribing");
    const segments = await transcribe(audioPath);

    await updateStatus(jobId, "translating", { transcript: segments });
    const translatedSegments = await translateSegments(segments, job.targetLanguage);
    const withVoice = translatedSegments.map((s) => ({ ...s, voice: DEFAULT_VOICE }));

    await updateStatus(jobId, "reviewing", { translatedTranscript: withVoice });
  } catch (error) {
    console.error(`DubJob ${jobId} failed (transcribe/translate):`, error);
    await updateStatus(jobId, "failed", { errorMessage: String(error?.message || error) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Phase 2: triggered on demand once the user finishes reviewing/editing the
// transcript and per-segment voices. Independent temp workDir/lifecycle from
// phase 1 — reads only from the persistent sourceDir, so it doesn't matter
// how long the review step took or whether phase 1's temp files are gone.
export async function runDubAndMux(jobId) {
  const job = await prisma.dubJob.findUniqueOrThrow({ where: { id: jobId } });
  const sourceDir = jobDir(jobId);
  const dir = workDir(jobId);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const persistentVideoPath = path.join(sourceDir, "source.mp4");
    const totalDuration = await getMediaDuration(persistentVideoPath);

    // Re-validate voices server-side even though the PATCH endpoint already
    // did (defense in depth in case a row predates this feature).
    const translatedSegments = (job.translatedTranscript || []).map((s) => ({
      ...s,
      voice: isValidVoice(s.voice) ? s.voice : DEFAULT_VOICE,
    }));

    // Rebuild the SRT from whatever text is stored now, since the user may
    // have edited it during review — the subtitle file should match what's
    // actually spoken in the dubbed audio.
    const srtPath = path.join(dir, "subtitles.srt");
    fs.writeFileSync(srtPath, buildSrt(translatedSegments));
    const persistentSrtPath = path.join(sourceDir, "subtitles.srt");
    fs.copyFileSync(srtPath, persistentSrtPath);

    const dubbedAudioPath = await assembleSegmentAudio(translatedSegments, dir, totalDuration);

    await updateStatus(jobId, "muxing");
    const localOutputPath = path.join(dir, "output.mp4");
    await muxFinalVideo({
      videoPath: persistentVideoPath,
      audioPath: dubbedAudioPath,
      srtPath,
      outputPath: localOutputPath,
      targetLanguage: job.targetLanguage,
    });

    const outputPath = path.join(sourceDir, "output.mp4");
    fs.copyFileSync(localOutputPath, outputPath);

    await updateStatus(jobId, "done", {
      outputPath,
      subtitlesPath: persistentSrtPath,
      translatedTranscript: translatedSegments,
    });
  } catch (error) {
    console.error(`DubJob ${jobId} failed (dub/mux):`, error);
    await updateStatus(jobId, "failed", { errorMessage: String(error?.message || error) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
