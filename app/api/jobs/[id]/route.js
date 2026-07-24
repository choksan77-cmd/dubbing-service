import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { prisma } from "../../../../lib/prisma";

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
  });
}
