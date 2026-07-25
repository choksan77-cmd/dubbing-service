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

// Fully mutes the ORIGINAL audio during every window where Whisper detected
// speech (the raw start/end timestamps — the original video's own fixed
// timeline; this track is never time-shifted, so this must stay in the
// original video's own real timeline regardless of any dubbed-audio drift)
// so the original spoken dialogue is never audible, while leaving
// everything else (sound effects, hits, background music, ambience)
// untouched at full volume. Each window is padded by MUTE_PAD_SECONDS on
// both sides — Whisper's segment boundaries aren't frame-accurate and can
// clip a few hundred ms off the start/end of fast speech, letting a
// syllable of the original dialogue slip through right at the edges
// (heard as brief blips of the original language between lines). One
// `volume` filter stage per segment chained in a single -af pass — still a
// single real input, no filter_complex.
const MUTE_PAD_SECONDS = 0.2;

async function muteOriginalDuringDialogue(originalAudioPath, translatedSegments, outputPath) {
  const filters = translatedSegments.map(
    (s) =>
      `volume=0:enable='between(t\\,${Math.max(0, s.start - MUTE_PAD_SECONDS).toFixed(3)}\\,${(
        s.end + MUTE_PAD_SECONDS
      ).toFixed(3)})'`
  );

  if (filters.length === 0) {
    fs.copyFileSync(originalAudioPath, outputPath);
    return;
  }

  await execFileAsync(
    ffmpegPath,
    ["-y", "-nostdin", "-i", originalAudioPath, "-af", filters.join(","), "-c:a", "pcm_s16le", outputPath],
    { timeout: 5 * 60 * 1000 }
  );
}

// Combines the dubbed voice with the original track (already muted during
// dialogue windows, see above) — effects/music from the gaps layer in
// without any original speech ever playing. Two real inputs, simple amix,
// not the apad/multi-input combination that hung on Railway before.
async function mixDubbedWithOriginalEffects(dubbedAudioPath, mutedOriginalPath, outputPath) {
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-nostdin",
      "-i", dubbedAudioPath,
      "-i", mutedOriginalPath,
      "-filter_complex",
      "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
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
// Grabs a single frame near a segment's midpoint — fast input-side seeking
// (approximate, not frame-accurate, which is fine for "who's on screen").
// Single input, single output, same safe ffmpeg pattern as everything else.
async function extractFrameAtTime(videoPath, time, outputPath) {
  await execFileAsync(
    ffmpegPath,
    ["-y", "-nostdin", "-ss", Math.max(0, time).toFixed(3), "-i", videoPath, "-vframes", "1", "-vf", "scale=320:-1", outputPath],
    { timeout: 30 * 1000 }
  );
}

// Translates AND casts the dialogue in one pass, now WITH a video frame per
// segment alongside its text — text-only speaker inference (no visual
// signal at all) reliably mis-assigns short/generic lines ("what's going
// on?") when there's no textual clue which of several people said it.
// Feeding GPT-4o the actual frame lets it use who's visibly on screen, not
// just guess from the words. Frame extraction failures degrade gracefully
// (that segment just gets analyzed text-only instead of failing the job).
async function translateAndAnalyzeSegments(segments, targetLanguage, videoPath, dir) {
  const instructions =
    `You translate subtitle segments into ${targetLanguage} and analyze the dialogue to help cast voice actors. ` +
    `Each segment will also be dubbed by text-to-speech and must be spoken aloud within its own original time ` +
    `window (given in seconds after each segment's text below) at a natural conversational pace — a translation ` +
    `that's much longer to say than the original line will make the dubbed speech run past its slot and drift the ` +
    `whole rest of the video out of sync. Prioritize a natural, complete, correctly-toned translation first, but ` +
    `when a line is naturally verbose in ${targetLanguage}, actively prefer the shorter of two equally natural ` +
    `phrasings, drop redundant filler words/particles, and avoid padding — do not add words that aren't needed just ` +
    `to sound more polished. ` +
    `Each segment below is given as its text followed by a frame from the video at roughly that moment. Use BOTH ` +
    `signals together: the image can show who's visibly on screen, but frames are approximate and sometimes show ` +
    `nobody's face, a reaction shot, or an unclear angle — don't let a noisy/uninformative frame override a clear ` +
    `textual signal (an explicit name, a direct reply to a question, address terms). Only let the image override the ` +
    `text when the image clearly and unambiguously shows a specific person speaking. ` +
    `For each segment, infer: translatedText (the translation); speaker (a short consistent label for who is ` +
    `speaking, e.g. "시어머니", "며느리", "남편", "내레이션" — reuse the exact same label across every line from the ` +
    `same person). Read the WHOLE scene first, like blocking a screenplay: figure out how many distinct people ` +
    `actually appear across the conversation and what each one's role/relationship is, then assign every line ` +
    `consistently. Short or generic lines ("what's going on", reactions) give almost no textual signal on their own — ` +
    `for those, lean on a clear image if you have one, otherwise default to keeping the SAME speaker as the ` +
    `immediately preceding line rather than guessing a new one. Do not invent a new speaker label unless the dialogue ` +
    `or imagery genuinely demands it. Also infer: gender ("male" or "female", best guess for voice casting); age ("child", ` +
    `"young", "middle", or "elderly", best guess); emotion (one of "neutral", "calm", "angry", "crying", "happy", ` +
    `"sad" — the emotional tone of this specific line). ` +
    `Return a JSON object {"segments": [{"translatedText": "...", "speaker": "...", "gender": "...", "age": "...", ` +
    `"emotion": "..."}]} with exactly one entry per segment, in the same order as the segments were given, no extra commentary.`;

  const content = [{ type: "text", text: instructions }];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const budget = Math.max(0.1, seg.end - seg.start).toFixed(2);
    content.push({ type: "text", text: `Segment ${i} (must fit in ${budget}s spoken aloud): "${seg.text}"` });
    try {
      const framePath = path.join(dir, `speaker_frame_${i}.jpg`);
      await extractFrameAtTime(videoPath, (seg.start + seg.end) / 2, framePath);
      const base64 = fs.readFileSync(framePath).toString("base64");
      content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "low" } });
    } catch (error) {
      console.error(`Frame extraction failed for segment ${i}, continuing text-only:`, error);
    }
  }

  content.push({
    type: "text",
    text: `Return the JSON object now, with exactly ${segments.length} entries in "segments", matching the segments above in order.`,
  });

  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content }],
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

// Cap speed-up so dubbed speech still sounds reasonably natural — this isn't
// true mouth-movement lip-sync, so pace matters, but sync matters more:
// real-world testing on tightly-paced dialogue (near-continuous lines, no
// natural gaps to absorb drift) showed 1.3x let overflow compound to 6+
// seconds of drift by the end of a 37s clip, which is far worse than a
// faster-sounding voice. Combined with the duration budget now given to the
// translation step (see translateAndAnalyzeSegments), this is a safety net
// for whatever still runs long, not the primary defense.
const MAX_SPEEDUP = 1.6;

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
const FONT_FAMILY_NAME = "Noto Sans CJK KR";

// ffmpeg's filter-option parser treats ':' as a separator, which breaks
// Windows drive-letter paths (harmless no-op on Linux/Railway where paths
// never contain ':').
function escapeFfmpegPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// libass resolves fonts through the platform's font backend (fontconfig on
// Linux). A bare container may have no valid fontconfig setup at all, which
// makes font lookups silently fail rather than error — `fontsdir` alone
// wasn't enough to fix this on Railway. Pointing FONTCONFIG_FILE at a
// minimal, self-contained config that only references our bundled font
// directory removes the dependency on whatever (if anything) the container
// already has configured.
let fontConfigPathCache = null;
function ensureFontConfigFile() {
  if (fontConfigPathCache) return fontConfigPathCache;
  const cacheDir = path.join(os.tmpdir(), "fontconfig-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const confPath = path.join(os.tmpdir(), "dubbing-fonts.conf");
  const conf =
    `<?xml version="1.0"?>\n` +
    `<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n` +
    `<fontconfig>\n` +
    `  <dir>${FONTS_DIR.replace(/\\/g, "/")}</dir>\n` +
    `  <cachedir>${cacheDir.replace(/\\/g, "/")}</cachedir>\n` +
    `</fontconfig>\n`;
  fs.writeFileSync(confPath, conf);
  fontConfigPathCache = confPath;
  return confPath;
}

// Blurs a fixed band near the bottom of the frame to hide hardcoded
// source-language subtitles baked into the original video. Band position
// calibrated against a real vertical (9:16) short-form drama source: the
// previous band (0.76-0.91 of height) sat entirely BELOW the actual
// subtitle text, so it blurred empty background and left the original
// subtitles fully visible. Measured position on real footage is ~0.65-0.79
// of height; using 0.63-0.79 for margin. Single real input
// (self-referencing via split) — not combined with any other real file
// input, stays within the safe ffmpeg pattern. Requires re-encoding (can't
// stream-copy once a filter touches the video).
async function blurSubtitleRegion(videoPath, outputPath) {
  await execFileAsync(
    ffmpegPath,
    [
      "-y", "-nostdin", "-i", videoPath,
      "-filter_complex",
      "split[base][b];[b]crop=iw:ih*0.16:0:ih*0.63,boxblur=12:3[blurred];[base][blurred]overlay=0:main_h*0.63",
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
// untouched original-language hardcoded subtitles.
//
// Tried `drawtext` with a direct fontfile= path first (avoids font-name
// lookup entirely) — turned out Railway's ffmpeg-static Linux binary
// doesn't have the drawtext filter compiled in at all ("No such filter").
// `subtitles`/libass IS present there, so that's the only option; its
// font resolution goes through the platform's font backend (fontconfig on
// Linux) rather than loading a file directly, which is why `fontsdir`
// alone silently rendered nothing on Railway even though this exact setup
// worked locally on Windows (where libass uses DirectWrite instead).
// FONTCONFIG_FILE pins font resolution to a minimal config that only
// references our bundled font directory, removing any dependency on
// whatever (if anything) fontconfig has configured in the container.
async function burnInSubtitles(videoPath, srtPath, outputPath) {
  const vf = [
    `subtitles='${escapeFfmpegPath(srtPath)}'`,
    `fontsdir='${escapeFfmpegPath(FONTS_DIR)}'`,
    `force_style='FontName=${FONT_FAMILY_NAME},Bold=1,FontSize=30,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=50'`,
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
    { timeout: 5 * 60 * 1000, env: { ...process.env, FONTCONFIG_FILE: ensureFontConfigFile() } }
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
    "-shortest",
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
    const analyzedSegments = await translateAndAnalyzeSegments(segments, job.targetLanguage, videoPath, dir);
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

    // Mix the original audio back in for sound effects / hits / background
    // music (replacing the track outright discarded all of that, not just
    // the original dialogue) — but fully muted during every window where
    // the original spoken dialogue actually is, so that dialogue itself is
    // never audible under the dub.
    const originalAudioPath = path.join(dir, "original_for_mix.wav");
    await extractOriginalAudioForMixing(persistentVideoPath, originalAudioPath);
    const mutedOriginalPath = path.join(dir, "original_muted.wav");
    await muteOriginalDuringDialogue(originalAudioPath, translatedSegments, mutedOriginalPath);
    const mixedAudioPath = path.join(dir, "mixed_audio.wav");
    await mixDubbedWithOriginalEffects(dubbedAudioPath, mutedOriginalPath, mixedAudioPath);

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
