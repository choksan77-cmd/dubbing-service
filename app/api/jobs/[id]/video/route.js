import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, canViewJob } from "../../../../../lib/auth";
import { prisma } from "../../../../../lib/prisma";
import { streamVideoFile } from "../../../../../lib/streamVideo";

export async function GET(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const job = await prisma.dubJob.findUnique({ where: { id: params.id } });
  if (!job || !canViewJob(job, session) || !job.outputPath) {
    return NextResponse.json({ error: "찾을 수 없습니다." }, { status: 404 });
  }

  return streamVideoFile(request, job.outputPath, `dubbed-${job.id}.mp4`);
}
