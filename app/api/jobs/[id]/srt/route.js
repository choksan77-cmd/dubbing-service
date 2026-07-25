import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import fs from "fs";
import { Readable } from "stream";
import { authOptions } from "../../../../../lib/auth";
import { prisma } from "../../../../../lib/prisma";

export async function GET(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const job = await prisma.dubJob.findUnique({ where: { id: params.id } });
  if (!job || job.userId !== session.user.id || !job.subtitlesPath) {
    return NextResponse.json({ error: "찾을 수 없습니다." }, { status: 404 });
  }

  const stat = fs.statSync(job.subtitlesPath);
  const stream = fs.createReadStream(job.subtitlesPath);

  return new NextResponse(Readable.toWeb(stream), {
    headers: {
      "Content-Type": "application/x-subrip",
      "Content-Length": stat.size.toString(),
      "Content-Disposition": `attachment; filename="dubbed-${job.id}.srt"`,
    },
  });
}
