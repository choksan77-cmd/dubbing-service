import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import { authOptions } from "../../../../lib/auth";
import { prisma } from "../../../../lib/prisma";
import { jobDir } from "../../../../lib/pipeline";
import { DEFAULT_VOICE, isValidVoice } from "../../../../lib/voices";

export async function GET(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const job = await prisma.dubJob.findUnique({ where: { id: params.id } });
  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({ error: "찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    errorMessage: job.errorMessage,
    translatedTranscript: job.translatedTranscript,
    hasOutput: !!job.outputPath,
    hasSubtitles: !!job.subtitlesPath,
    hasSource: fs.existsSync(`${jobDir(job.id)}/source.mp4`),
  });
}

export async function PATCH(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const job = await prisma.dubJob.findUnique({ where: { id: params.id } });
  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({ error: "찾을 수 없습니다." }, { status: 404 });
  }

  if (job.status !== "reviewing") {
    return NextResponse.json({ error: "검토 단계가 아닌 작업은 수정할 수 없습니다." }, { status: 409 });
  }

  const body = await request.json();
  const edits = Array.isArray(body.segments) ? body.segments : null;
  const storedSegments = job.translatedTranscript || [];

  if (!edits || edits.length !== storedSegments.length) {
    return NextResponse.json({ error: "세그먼트 목록이 일치하지 않습니다." }, { status: 400 });
  }

  // Merge by index — never trust client-submitted start/end/text, those stay
  // server-authoritative since they drive timing alignment during synthesis.
  const merged = storedSegments.map((s, i) => ({
    ...s,
    translatedText:
      typeof edits[i]?.translatedText === "string" ? edits[i].translatedText : s.translatedText,
    voice: isValidVoice(edits[i]?.voice) ? edits[i].voice : DEFAULT_VOICE,
  }));

  await prisma.dubJob.update({
    where: { id: params.id },
    data: { translatedTranscript: merged },
  });

  return NextResponse.json({ translatedTranscript: merged });
}
