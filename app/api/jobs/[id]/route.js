import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import { authOptions } from "../../../../lib/auth";
import { prisma } from "../../../../lib/prisma";
import { jobDir } from "../../../../lib/pipeline";
import { DEFAULT_VOICE, isValidVoice } from "../../../../lib/voices";
import { DEFAULT_EMOTION, isValidEmotion } from "../../../../lib/emotions";

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
    characters: job.characters,
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
  const submittedCharacters = Array.isArray(body.characters) ? body.characters : null;
  const edits = Array.isArray(body.segments) ? body.segments : null;
  const storedSegments = job.translatedTranscript || [];

  if (!submittedCharacters || submittedCharacters.length === 0) {
    return NextResponse.json({ error: "등장인물이 최소 1명 필요합니다." }, { status: 400 });
  }
  if (!edits || edits.length !== storedSegments.length) {
    return NextResponse.json({ error: "세그먼트 목록이 일치하지 않습니다." }, { status: 400 });
  }

  const characters = submittedCharacters.map((c) => ({
    id: String(c?.id || ""),
    name: typeof c?.name === "string" && c.name.trim() ? c.name.trim() : "화자",
    voice: isValidVoice(c?.voice) ? c.voice : DEFAULT_VOICE,
  }));
  const characterIds = new Set(characters.map((c) => c.id));

  // Merge by index — never trust client-submitted start/end/text, those stay
  // server-authoritative since they drive timing alignment during synthesis.
  // characterId must reference one of the characters just submitted in this
  // same request (not the old stored list) so the two arrays stay consistent.
  const merged = storedSegments.map((s, i) => ({
    ...s,
    translatedText:
      typeof edits[i]?.translatedText === "string" ? edits[i].translatedText : s.translatedText,
    characterId: characterIds.has(edits[i]?.characterId) ? edits[i].characterId : characters[0].id,
    emotion: isValidEmotion(edits[i]?.emotion) ? edits[i].emotion : DEFAULT_EMOTION,
  }));

  await prisma.dubJob.update({
    where: { id: params.id },
    data: { translatedTranscript: merged, characters },
  });

  return NextResponse.json({ translatedTranscript: merged, characters });
}
