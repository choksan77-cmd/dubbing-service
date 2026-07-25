import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import os from "os";
import path from "path";
import { authOptions } from "../../../lib/auth";
import { prisma } from "../../../lib/prisma";
import {
  runTranscribeAndTranslate,
  jobDir,
  getMediaDuration,
  splitVideoIntoChunks,
  CHUNK_SECONDS,
} from "../../../lib/pipeline";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const isAdmin = session.user.role === "admin";
  const jobs = await prisma.dubJob.findMany({
    where: isAdmin ? {} : { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: isAdmin ? { user: { select: { email: true, name: true } } } : undefined,
  });

  return NextResponse.json(
    jobs.map((job) => ({
      id: job.id,
      status: job.status,
      sourceType: job.sourceType,
      originalFilename: job.originalFilename,
      sourceUrl: job.sourceUrl,
      targetLanguage: job.targetLanguage,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      hasOutput: !!job.outputPath,
      hasSubtitles: !!job.subtitlesPath,
      hasSource: fs.existsSync(path.join(jobDir(job.id), "source.mp4")),
      progressCurrent: job.progressCurrent,
      progressTotal: job.progressTotal,
      ownerEmail: isAdmin ? job.user?.email : undefined,
      ownerName: isAdmin ? job.user?.name : undefined,
    }))
  );
}

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";

  let sourceType;
  let sourceUrl = null;
  let originalFilename = null;
  let targetLanguage;
  let fileBuffer = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    targetLanguage = formData.get("targetLanguage");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "영상 파일이 필요합니다." }, { status: 400 });
    }

    sourceType = "upload";
    originalFilename = file.name;
    fileBuffer = Buffer.from(await file.arrayBuffer());
  } else {
    const body = await request.json();
    sourceType = "youtube";
    sourceUrl = body.youtubeUrl;
    targetLanguage = body.targetLanguage;

    if (!sourceUrl) {
      return NextResponse.json({ error: "YouTube URL이 필요합니다." }, { status: 400 });
    }
  }

  if (!targetLanguage) {
    return NextResponse.json({ error: "번역할 언어를 선택해주세요." }, { status: 400 });
  }

  // Long uploads get split into fixed-length pieces up front, each becoming
  // its own independent job (no re-stitching afterward) — sidesteps
  // Whisper's 25MB audio upload limit for long videos and keeps every
  // per-job pipeline call (translation chunking, TTS, ffmpeg) working on a
  // duration it was already built and tested for.
  if (fileBuffer) {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dubbing-upload-"));
    try {
      const stagingPath = path.join(stagingDir, originalFilename);
      fs.writeFileSync(stagingPath, fileBuffer);

      const duration = await getMediaDuration(stagingPath);
      const chunkPaths =
        duration > CHUNK_SECONDS ? await splitVideoIntoChunks(stagingPath, stagingDir) : [stagingPath];

      const ext = path.extname(originalFilename) || ".mp4";
      const base = path.basename(originalFilename, ext);
      const ids = [];

      for (let i = 0; i < chunkPaths.length; i++) {
        const chunkFilename =
          chunkPaths.length > 1 ? `${base} (${i + 1}-${chunkPaths.length})${ext}` : originalFilename;

        const job = await prisma.dubJob.create({
          data: {
            userId: session.user.id,
            sourceType,
            sourceUrl: null,
            originalFilename: chunkFilename,
            targetLanguage,
          },
        });

        const dir = jobDir(job.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(chunkPaths[i], path.join(dir, chunkFilename));

        runTranscribeAndTranslate(job.id);
        ids.push(job.id);
      }

      return NextResponse.json({ ids, id: ids[0], chunked: ids.length > 1 });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  const job = await prisma.dubJob.create({
    data: {
      userId: session.user.id,
      sourceType,
      sourceUrl,
      originalFilename,
      targetLanguage,
    },
  });

  runTranscribeAndTranslate(job.id);

  return NextResponse.json({ id: job.id, ids: [job.id] });
}
