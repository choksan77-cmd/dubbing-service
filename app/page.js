"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";

export default function Home() {
  const { data: session, status } = useSession();

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        fontFamily: "sans-serif",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1>번역더빙 서비스</h1>
      <p>해외 영상을 올리면 번역·더빙·자막을 자동으로 입혀드립니다.</p>

      {status === "authenticated" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p>{session.user.name || session.user.email}님 환영합니다.</p>
          <button onClick={() => signOut()} style={{ padding: "0.4rem 0.8rem" }}>
            로그아웃
          </button>
        </div>
      ) : status === "loading" ? null : (
        <div style={{ display: "flex", gap: "1rem" }}>
          <Link href="/login">로그인</Link>
          <Link href="/signup">회원가입</Link>
        </div>
      )}

      <p style={{ color: "#888", fontSize: "0.9rem" }}>
        배포 파이프라인 테스트용 기본 페이지입니다.
      </p>
    </main>
  );
}
