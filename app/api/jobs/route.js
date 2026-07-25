import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import path from "path";
import { authOptions } from "../../../lib/auth";
import { prisma } from "../../../lib/prisma";
import { runPipeline, jobDir } from "../../../lib/pipeline";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const jobs = await prisma.dubJob.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
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

  const job = await prisma.dubJob.create({
    data: {
      userId: session.user.id,
      sourceType,
      sourceUrl,
      originalFilename,
      targetLanguage,
    },
  });

  if (fileBuffer) {
    const dir = jobDir(job.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, originalFilename), fileBuffer);
  }

  runPipeline(job.id);

  return NextResponse.json({ id: job.id });
}
