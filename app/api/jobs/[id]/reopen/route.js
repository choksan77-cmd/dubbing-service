import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { prisma } from "../../../../../lib/prisma";

// Lets the user go back and edit a completed job's script/characters again —
// the last-saved translatedTranscript/characters are still in the row, so
// flipping the status back is all that's needed to resume the studio editor
// exactly where it left off.
export async function POST(request, { params }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const result = await prisma.dubJob.updateMany({
    where: { id: params.id, userId: session.user.id, status: "done" },
    data: { status: "reviewing" },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { error: "완료된 작업만 다시 수정할 수 있습니다." },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true });
}
