import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegPath from "ffmpeg-static";
import ytdlp from "yt-dlp-exec";
import { prisma } from "./prisma";
import { getOpenAI } from "./openai";

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

async function synthesizeSpeech(text, outputPath) {
  const response = await getOpenAI().audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
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

export async function runPipeline(jobId) {
  const job = await prisma.dubJob.findUniqueOrThrow({ where: { id: jobId } });
  const sourceDir = jobDir(jobId);
  const dir = workDir(jobId);
  fs.mkdirSync(dir, { recursive: true });

  try {
    await updateStatus(jobId, "downloading");
    const videoPath = await downloadSource(job, sourceDir, dir);

    const audioPath = path.join(dir, "audio.wav");
    await extractAudio(videoPath, audioPath);

    await updateStatus(jobId, "transcribing");
    const segments = await transcribe(audioPath);

    await updateStatus(jobId, "translating", { transcript: segments });
    const translatedSegments = await translateSegments(segments, job.targetLanguage);
    const srtPath = path.join(dir, "subtitles.srt");
    fs.writeFileSync(srtPath, buildSrt(translatedSegments));

    await updateStatus(jobId, "dubbing", { translatedTranscript: translatedSegments });
    const fullTranslatedText = translatedSegments.map((s) => s.translatedText).join(" ");
    const dubbedAudioPath = path.join(dir, "dubbed_audio.mp3");
    await synthesizeSpeech(fullTranslatedText, dubbedAudioPath);

    await updateStatus(jobId, "muxing");
    const localOutputPath = path.join(dir, "output.mp4");
    await muxFinalVideo({
      videoPath,
      audioPath: dubbedAudioPath,
      srtPath,
      outputPath: localOutputPath,
      targetLanguage: job.targetLanguage,
    });

    const outputPath = path.join(sourceDir, "output.mp4");
    fs.copyFileSync(localOutputPath, outputPath);

    await updateStatus(jobId, "done", { outputPath });
  } catch (error) {
    console.error(`DubJob ${jobId} failed:`, error);
    await updateStatus(jobId, "failed", { errorMessage: String(error?.message || error) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
