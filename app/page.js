"use client";

import { useSession } from "next-auth/react";
import Link from "next/link";
import styles from "./home.module.css";

export default function Home() {
  const { data: session, status } = useSession();

  return (
    <main className="page pageCentered">
      <div className={styles.hero}>
        <h1 className={styles.title}>번역더빙 서비스</h1>
        <p className={styles.subtitle}>해외 영상을 올리면 번역·더빙·자막을 자동으로 입혀드립니다.</p>

        {status === "authenticated" ? (
          <div className={styles.actions}>
            <p className={styles.welcome}>{session.user.name || session.user.email}님 환영합니다.</p>
            <Link href="/dub" className="button buttonPrimary">
              더빙 시작하기
            </Link>
          </div>
        ) : status === "loading" ? null : (
          <div className={styles.actions}>
            <Link href="/signup" className="button buttonPrimary">
              무료로 시작하기
            </Link>
            <Link href="/login" className="button">
              로그인
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
