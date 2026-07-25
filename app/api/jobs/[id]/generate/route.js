import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { prisma } from "../../../../../lib/prisma";
import { runDubAndMux } from "../../../../../lib/pipeline";

export async function POST(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  // Atomic conditional update — if two requests race (double-click, retry),
  // only the one that actually flips reviewing -> dubbing triggers the run,
  // so runDubAndMux never fires twice for the same job's workDir.
  const result = await prisma.dubJob.updateMany({
    where: { id: params.id, userId: session.user.id, status: "reviewing" },
    data: { status: "dubbing" },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { error: "검토 단계가 아니거나 이미 더빙이 시작된 작업입니다." },
      { status: 409 }
    );
  }

  runDubAndMux(params.id);

  return NextResponse.json({ ok: true });
}
