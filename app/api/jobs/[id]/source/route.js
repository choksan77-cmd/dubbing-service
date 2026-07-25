import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import path from "path";
import { authOptions } from "../../../../../lib/auth";
import { prisma } from "../../../../../lib/prisma";
import { jobDir } from "../../../../../lib/pipeline";
import { streamVideoFile } from "../../../../../lib/streamVideo";

export async function GET(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const job = await prisma.dubJob.findUnique({ where: { id: params.id } });
  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({ error: "찾을 수 없습니다." }, { status: 404 });
  }

  const sourcePath = path.join(jobDir(job.id), "source.mp4");
  if (!fs.existsSync(sourcePath)) {
    return NextResponse.json({ error: "찾을 수 없습니다." }, { status: 404 });
  }

  return streamVideoFile(request, sourcePath, `source-${job.id}.mp4`);
}
