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
import { DEFAULT_EMOTION, isValidEmotion, getEmotionInstructions } from "./emotions";
import { DEFAULT_VOICE_STYLE, isValidVoiceStyle, getVoiceStyleInstructions } from "./voiceStyles";

const DEFAULT_CHARACTER_ID = "c1";

function defaultCharacters() {
  return [
    { id: DEFAULT_CHARACTER_ID, name: "화자 1", voice: DEFAULT_VOICE, style: DEFAULT_VOICE_STYLE },
  ];
}

// Server-side revalidation of a characters array (defense in depth — the
// PATCH endpoint already validates, but a row could predate this feature or
// arrive corrupted). Always returns at least one valid character.
function sanitizeCharacters(characters) {
  const list = Array.isArray(characters) && characters.length ? characters : defaultCharacters();
  return list.map((c) => ({
    id: c.id,
    name: c.name || "화자",
    voice: isValidVoice(c.voice) ? c.voice : DEFAULT_VOICE,
    style: isValidVoiceStyle(c.style) ? c.style : DEFAULT_VOICE_STYLE,
  }));
}

// Combines a character's age/style steering with a line's emotion steering
// into one instructions string for the TTS call (either half may be absent).
function combineInstructions(character, emotion) {
  const parts = [getVoiceStyleInstructions(character.style), getEmotionInstructions(emotion)].filter(
    Boolean
  );
  return parts.length ? parts.join(" ") : null;
}

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

// Same idea as extractAudio but at the dubbed track's sample rate (44100),
// for mixing rather than for Whisper.
async function extractOriginalAudioForMixing(videoPath, audioPath) {
  await execFileAsync(ffmpegPath, [
    "-y", "-nostdin", "-i", videoPath,
    "-vn", "-ac", "1", "-ar", "44100", "-acodec", "pcm_s16le",
    audioPath,
  ], { timeout: 5 * 60 * 1000 });
}

// Ducks the original audio well under the dubbed voice and mixes them —
// otherwise replacing the track outright silently discards every sound
// effect, hit/slap sound, and background music from the source video, not
// just the original dialogue. This doesn't remove the original spoken
// dialogue (no vocal-isolation model in this stack), so it stays faintly
// audible under the dub — an accepted tradeoff, see plan. Two real inputs,
// but a simple volume+amix graph — not the apad/multi-input combination
// that hung on Railway before.
async function mixWithOriginalAudio(dubbedAudioPath, originalAudioPath, outputPath) {
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-nostdin",
      "-i", dubbedAudioPath,
      "-i", originalAudioPath,
      "-filter_complex",
      "[1:a]volume=0.18[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
      "-c:a", "pcm_s16le",
      outputPath,
    ],
    { timeout: 5 * 60 * 1000 }
  );
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

// Translates AND casts the dialogue in one pass: since there's no real
// speaker-diarization model in this stack, we use GPT-4o's reading of the
// dialogue content itself (address terms, turn-taking, context) as a
// practical stand-in for "who's speaking" — imperfect vs. real audio
// diarization, but removes the need for the user to manually build a cast
// from a blank slate for every job.
async function translateAndAnalyzeSegments(segments, targetLanguage) {
  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You translate subtitle segments into ${targetLanguage} and analyze the dialogue to help cast voice actors. ` +
          `For each input segment, infer: translatedText (the translation); speaker (a short consistent label for who is ` +
          `speaking, e.g. "시어머니", "며느리", "남편", "내레이션" — reuse the exact same label across every line from the ` +
          `same person, inferred from address terms/context/turn-taking; if truly ambiguous use "화자 1" etc); gender ` +
          `("male" or "female", best guess for voice casting); age ("child", "young", "middle", or "elderly", best guess); ` +
          `emotion (one of "neutral", "calm", "angry", "crying", "happy", "sad" — the emotional tone of this specific line). ` +
          `Return a JSON object {"segments": [{"translatedText": "...", "speaker": "...", "gender": "...", "age": "...", ` +
          `"emotion": "..."}]} with exactly one entry per input segment, same order, no extra commentary.`,
      },
      {
        role: "user",
        content: JSON.stringify(segments.map((s) => s.text)),
      },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  const analyzed = parsed.segments || [];

  return segments.map((s, i) => ({
    ...s,
    translatedText: analyzed[i]?.translatedText || "",
    speaker: typeof analyzed[i]?.speaker === "string" && analyzed[i].speaker.trim()
      ? analyzed[i].speaker.trim()
      : "화자 1",
    gender: analyzed[i]?.gender === "female" ? "female" : "male",
    age: ["child", "young", "elderly"].includes(analyzed[i]?.age) ? analyzed[i].age : "middle",
    emotion: isValidEmotion(analyzed[i]?.emotion) ? analyzed[i].emotion : DEFAULT_EMOTION,
  }));
}

function pickVoiceForCast(gender, age) {
  if (gender === "female") {
    if (age === "elderly") return "sage";
    if (age === "child" || age === "young") return "nova";
    return "coral";
  }
  if (age === "elderly") return "onyx";
  if (age === "child" || age === "young") return "verse";
  return "echo";
}

function pickStyleForAge(age) {
  if (age === "child") return "child";
  if (age === "elderly") return "elderly";
  if (age === "young") return "young";
  return DEFAULT_VOICE_STYLE;
}

// Builds a characters[] cast from the per-segment speaker/gender/age
// analysis above — one character per unique inferred speaker label, in
// first-appearance order, each auto-assigned a voice + age style.
function buildCharactersFromAnalysis(analyzedSegments) {
  const seen = new Map();
  for (const seg of analyzedSegments) {
    if (!seen.has(seg.speaker)) {
      seen.set(seg.speaker, {
        id: seen.size === 0 ? DEFAULT_CHARACTER_ID : `c${seen.size + 1}`,
        name: seg.speaker,
        voice: pickVoiceForCast(seg.gender, seg.age),
        style: pickStyleForAge(seg.age),
      });
    }
  }
  const characters = Array.from(seen.values());
  return characters.length ? characters : defaultCharacters();
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

// Uses the ACTUAL playback timeline (post drift/atempo adjustment), not the
// raw Whisper timestamps — otherwise subtitles fall out of sync with the
// dubbed audio whenever a segment overflowed its original slot.
function buildSrt(translatedSegments, timeline) {
  return translatedSegments
    .map(
      (s, i) =>
        `${i + 1}\n${srtTimestamp(timeline[i].actualStart)} --> ${srtTimestamp(timeline[i].actualEnd)}\n${s.translatedText}\n`
    )
    .join("\n");
}

async function synthesizeSpeechSegment(text, outputPath, voice, instructions) {
  const response = await getOpenAI().audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: isValidVoice(voice) ? voice : DEFAULT_VOICE,
    input: text,
    response_format: "wav",
    ...(instructions ? { instructions } : {}),
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

// Also loudness-normalizes to a fixed target (-16 LUFS, standard dialogue
// level) so every segment lands at consistent volume regardless of how loud
// the TTS API happened to render that particular voice/line — otherwise
// volume audibly jumps up/down between segments. Single input, single
// filter, still just one ffmpeg call.
async function normalizeToCanonicalWav(inputPath, outputPath) {
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-nostdin", "-i", inputPath,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le",
      outputPath,
    ],
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
//
// Returns { dubbedAudioPath, timeline } — timeline[i] is the segment's ACTUAL
// {actualStart, actualEnd} in the assembled track, which can differ from the
// original seg.start/seg.end once any earlier segment overflows its slot
// (atempo capped at MAX_SPEEDUP). The cursor must always advance from where
// audio actually is, never reset back to the original script timestamps —
// doing so previously caused subtitle/audio desync that compounded over the
// video's length.
async function assembleSegmentAudio(translatedSegments, characters, dir, totalDurationSeconds) {
  const rawPaths = await mapWithConcurrency(translatedSegments, 4, async (seg, i) => {
    const text = (seg.translatedText || "").trim();
    if (!text) return null;
    const character = characters.find((c) => c.id === seg.characterId) || characters[0];
    const instructions = combineInstructions(character, seg.emotion);
    const rawPath = path.join(dir, `seg_${i}_raw.wav`);
    await synthesizeSpeechSegment(text, rawPath, character.voice, instructions);
    return rawPath;
  });

  const concatEntries = [];
  const timeline = [];
  let cursor = 0;

  for (let i = 0; i < translatedSegments.length; i++) {
    const seg = translatedSegments[i];
    const targetDur = Math.max(0.05, seg.end - seg.start);

    const gapDur = Math.max(0, seg.start - cursor);
    const gapPath = await generateSilence(gapDur, path.join(dir, `gap_${i}.wav`));
    if (gapPath) concatEntries.push(gapPath);

    const actualSegStart = cursor + gapDur; // = max(seg.start, cursor)
    let actualDur = 0;

    if (rawPaths[i]) {
      const normPath = path.join(dir, `seg_${i}_norm.wav`);
      await normalizeToCanonicalWav(rawPaths[i], normPath);
      const naturalDur = await getMediaDuration(normPath);

      let finalPath = normPath;
      actualDur = naturalDur;

      if (naturalDur > targetDur && naturalDur > 0) {
        // speech is longer than its slot: speed up to fit rather than cutting
        // it off. If clamped at MAX_SPEEDUP, it overflows its slot and later
        // segments simply drift later (accepted tradeoff, see plan) — but the
        // returned timeline reflects that drift accurately, so subtitles stay
        // in sync even when this happens.
        const tempoPath = path.join(dir, `seg_${i}_tempo.wav`);
        const appliedFactor = await applyAtempo(normPath, tempoPath, naturalDur / targetDur);
        finalPath = tempoPath;
        actualDur = naturalDur / appliedFactor;
      }

      concatEntries.push(finalPath);
    }

    let actualSegEnd = actualSegStart + actualDur;

    if (actualDur < targetDur) {
      // shorter than its slot (or no speech at all): pad with silence rather
      // than slowing speech down, which would sound unnatural.
      const padPath = await generateSilence(targetDur - actualDur, path.join(dir, `pad_${i}.wav`));
      if (padPath) concatEntries.push(padPath);
      actualSegEnd = actualSegStart + targetDur;
    }

    timeline.push({ actualStart: actualSegStart, actualEnd: actualSegEnd });
    cursor = actualSegEnd;
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

  return { dubbedAudioPath, timeline };
}

const FONTS_DIR = path.join(process.cwd(), "assets", "fonts");

// ffmpeg's filter-option parser treats ':' as a separator, which breaks
// Windows drive-letter paths (harmless no-op on Linux/Railway where paths
// never contain ':').
function escapeFfmpegPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// Blurs a fixed band near the bottom of the frame to hide hardcoded
// source-language subtitles baked into the original video. Single real
// input (self-referencing via split) — not combined with any other real
// file input, stays within the safe ffmpeg pattern. Requires re-encoding
// (can't stream-copy once a filter touches the video).
async function blurSubtitleRegion(videoPath, outputPath) {
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-nostdin", "-i", videoPath,
      "-filter_complex",
      "split[base][b];[b]crop=iw:ih*0.22:0:ih*0.68,boxblur=15:3[blurred];[base][blurred]overlay=0:main_h*0.68",
      "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      outputPath,
    ],
    { timeout: 5 * 60 * 1000 }
  );
}

// Burns the translated SRT directly into the video pixels (libass, via
// ffmpeg's `subtitles` filter) instead of a soft mov_text track — a soft
// track doesn't render by default in most players, so viewers just saw the
// untouched original-language hardcoded subtitles. fontsdir points at a
// bundled Korean-capable font so this doesn't depend on the container having
// any fonts installed.
async function burnInSubtitles(videoPath, srtPath, outputPath) {
  const vf = [
    `subtitles='${escapeFfmpegPath(srtPath)}'`,
    `fontsdir='${escapeFfmpegPath(FONTS_DIR)}'`,
    `force_style='FontName=Noto Sans KR,FontSize=20,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Alignment=2,MarginV=60'`,
  ].join(":");

  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-nostdin", "-i", videoPath,
      "-vf", vf,
      "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      outputPath,
    ],
    { timeout: 5 * 60 * 1000 }
  );
}

async function muxFinalVideo({ videoPath, audioPath, srtPath, outputPath }) {
  const blurredPath = outputPath.replace(/\.mp4$/, ".blurred.mp4");
  const subtitledPath = outputPath.replace(/\.mp4$/, ".subtitled.mp4");

  await blurSubtitleRegion(videoPath, blurredPath);
  await burnInSubtitles(blurredPath, srtPath, subtitledPath);

  await execFileAsync(ffmpegPath, [
    "-y",
    "-nostdin",
    "-i", subtitledPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "copy",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outputPath,
  ], { timeout: 5 * 60 * 1000 });

  fs.rmSync(blurredPath, { force: true });
  fs.rmSync(subtitledPath, { force: true });
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
    const analyzedSegments = await translateAndAnalyzeSegments(segments, job.targetLanguage);
    const characters = buildCharactersFromAnalysis(analyzedSegments);
    const speakerToCharacterId = new Map(characters.map((c) => [c.name, c.id]));
    const withCast = analyzedSegments.map(({ speaker, gender, age, ...s }) => ({
      ...s,
      characterId: speakerToCharacterId.get(speaker) || characters[0].id,
    }));

    await updateStatus(jobId, "reviewing", { translatedTranscript: withCast, characters });
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

    // Re-validate characters/segments server-side even though the PATCH
    // endpoint already did (defense in depth in case a row predates this
    // feature or arrives corrupted).
    const characters = sanitizeCharacters(job.characters);
    const characterIds = new Set(characters.map((c) => c.id));
    const translatedSegments = (job.translatedTranscript || []).map((s) => ({
      ...s,
      characterId: characterIds.has(s.characterId) ? s.characterId : characters[0].id,
      emotion: isValidEmotion(s.emotion) ? s.emotion : DEFAULT_EMOTION,
    }));

    // Assemble the dubbed audio FIRST so we know each segment's actual
    // playback position (may drift from the original script timestamps if
    // atempo hit its cap) — the SRT must be built from that real timeline,
    // not the raw Whisper timestamps, or subtitles fall out of sync.
    const { dubbedAudioPath, timeline } = await assembleSegmentAudio(
      translatedSegments,
      characters,
      dir,
      totalDuration
    );

    // Mix the ducked original audio back in underneath the dubbed voice so
    // sound effects / hits / background music aren't lost — replacing the
    // track outright discarded all of that, not just the original dialogue.
    const originalAudioPath = path.join(dir, "original_for_mix.wav");
    await extractOriginalAudioForMixing(persistentVideoPath, originalAudioPath);
    const mixedAudioPath = path.join(dir, "mixed_audio.wav");
    await mixWithOriginalAudio(dubbedAudioPath, originalAudioPath, mixedAudioPath);

    const srtPath = path.join(dir, "subtitles.srt");
    fs.writeFileSync(srtPath, buildSrt(translatedSegments, timeline));
    const persistentSrtPath = path.join(sourceDir, "subtitles.srt");
    fs.copyFileSync(srtPath, persistentSrtPath);

    await updateStatus(jobId, "muxing");
    const localOutputPath = path.join(dir, "output.mp4");
    await muxFinalVideo({
      videoPath: persistentVideoPath,
      audioPath: mixedAudioPath,
      srtPath,
      outputPath: localOutputPath,
    });

    const outputPath = path.join(sourceDir, "output.mp4");
    fs.copyFileSync(localOutputPath, outputPath);

    await updateStatus(jobId, "done", {
      outputPath,
      subtitlesPath: persistentSrtPath,
      translatedTranscript: translatedSegments,
      characters,
    });
  } catch (error) {
    console.error(`DubJob ${jobId} failed (dub/mux):`, error);
    await updateStatus(jobId, "failed", { errorMessage: String(error?.message || error) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
