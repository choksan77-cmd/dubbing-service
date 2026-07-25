"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import styles from "../components/auth.module.css";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "회원가입에 실패했습니다.");
        setLoading(false);
        return;
      }

      router.push("/login?signup=success");
    } catch (err) {
      setError("서버 오류가 발생했습니다.");
      setLoading(false);
    }
  }

  return (
    <main className="page pageCentered">
      <div className={`card ${styles.wrap}`}>
        <h1 className={styles.title}>회원가입</h1>
        <form onSubmit={handleSubmit} className={styles.form}>
          <input
            type="text"
            placeholder="이름 (선택)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="비밀번호 (8자 이상)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          {error && <p className="errorText">{error}</p>}
          <button type="submit" disabled={loading} className="button buttonPrimary">
            {loading ? "가입 중..." : "회원가입"}
          </button>
        </form>
        <p className={styles.footer}>
          이미 계정이 있으신가요? <Link href="/login">로그인</Link>
        </p>
      </div>
    </main>
  );
}
