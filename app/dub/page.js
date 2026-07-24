"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

const STATUS_LABELS = {
  pending: "대기 중",
  downloading: "영상 가져오는 중",
  transcribing: "음성 인식 중",
  translating: "번역 중",
  dubbing: "더빙 음성 생성 중",
  muxing: "영상에 합성 중",
  done: "완료",
  failed: "실패",
};

const LANGUAGES = [
  { value: "English", label: "영어" },
  { value: "Korean", label: "한국어" },
  { value: "Japanese", label: "일본어" },
  { value: "Chinese", label: "중국어" },
  { value: "Spanish", label: "스페인어" },
];

export default function DubPage() {
  const { status: sessionStatus } = useSession();
  const [inputMode, setInputMode] = useState("upload");
  const [file, setFile] = useState(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [targetLanguage, setTargetLanguage] = useState(LANGUAGES[0].value);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function pollJob(id) {
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/jobs/${id}`);
      const data = await res.json();
      setJob(data);
      if (data.status === "done" || data.status === "failed") {
        clearInterval(pollRef.current);
      }
    }, 3000);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    setJob(null);

    try {
      let res;
      if (inputMode === "upload") {
        if (!file) {
          setError("영상 파일을 선택해주세요.");
          setSubmitting(false);
          return;
        }
        const formData = new FormData();
        formData.append("file", file);
        formData.append("targetLanguage", targetLanguage);
        res = await fetch("/api/jobs", { method: "POST", body: formData });
      } else {
        res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ youtubeUrl, targetLanguage }),
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "요청에 실패했습니다.");
        setSubmitting(false);
        return;
      }

      setJob({ id: data.id, status: "pending" });
      pollJob(data.id);
    } catch (err) {
      setError("서버 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionStatus === "loading") return null;

  if (sessionStatus === "unauthenticated") {
    return (
      <main style={styles.main}>
        <p>이 기능을 사용하려면 로그인이 필요합니다.</p>
        <Link href="/login">로그인하러 가기</Link>
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <h1>영상 더빙</h1>

      <div style={{ display: "flex", gap: "1rem" }}>
        <button
          onClick={() => setInputMode("upload")}
          style={inputMode === "upload" ? styles.tabActive : styles.tab}
        >
          파일 업로드
        </button>
        <button
          onClick={() => setInputMode("youtube")}
          style={inputMode === "youtube" ? styles.tabActive : styles.tab}
        >
          YouTube URL
        </button>
      </div>

      <form onSubmit={handleSubmit} style={styles.form}>
        {inputMode === "upload" ? (
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        ) : (
          <input
            type="url"
            placeholder="https://www.youtube.com/watch?v=..."
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            style={styles.input}
          />
        )}

        <select
          value={targetLanguage}
          onChange={(e) => setTargetLanguage(e.target.value)}
          style={styles.input}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}로 더빙
            </option>
          ))}
        </select>

        {error && <p style={{ color: "red" }}>{error}</p>}

        <button type="submit" disabled={submitting} style={styles.input}>
          {submitting ? "제출 중..." : "더빙 시작"}
        </button>
      </form>

      {job && (
        <div style={styles.jobBox}>
          <p>상태: {STATUS_LABELS[job.status] || job.status}</p>
          {job.status === "failed" && (
            <p style={{ color: "red" }}>{job.errorMessage}</p>
          )}
          {job.status === "done" && job.hasOutput && (
            <div>
              <video
                src={`/api/jobs/${job.id}/video`}
                controls
                style={{ maxWidth: "100%" }}
              />
              <p>
                <a href={`/api/jobs/${job.id}/video`} download>
                  더빙된 영상 다운로드
                </a>
              </p>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

const styles = {
  main: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "1.5rem",
    fontFamily: "sans-serif",
    padding: "3rem 2rem",
  },
  tab: {
    padding: "0.5rem 1rem",
    background: "transparent",
    border: "1px solid #ccc",
  },
  tabActive: {
    padding: "0.5rem 1rem",
    border: "1px solid #333",
    fontWeight: "bold",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    width: "100%",
    maxWidth: "400px",
  },
  input: {
    padding: "0.5rem",
  },
  jobBox: {
    width: "100%",
    maxWidth: "500px",
    textAlign: "center",
  },
};
