"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import JobProgress from "../components/JobProgress";
import { VOICE_CATEGORIES } from "../../lib/voices";

const LANGUAGES = [
  { value: "English", label: "영어" },
  { value: "Korean", label: "한국어" },
  { value: "Japanese", label: "일본어" },
  { value: "Chinese", label: "중국어" },
  { value: "Spanish", label: "스페인어" },
];

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function DubStudio() {
  const { status: sessionStatus } = useSession();
  const searchParams = useSearchParams();

  const [inputMode, setInputMode] = useState("upload");
  const [file, setFile] = useState(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [targetLanguage, setTargetLanguage] = useState(LANGUAGES[0].value);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);

  const [segments, setSegments] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");

  const pollRef = useRef(null);
  const segmentsInitRef = useRef(null);
  const resumeAttemptedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function pollJob(id) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/jobs/${id}`);
      const data = await res.json();
      setJob(data);
      if (data.status === "done" || data.status === "failed" || data.status === "reviewing") {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 2000);
  }

  // Resume an existing job from /history via ?job=<id>
  useEffect(() => {
    if (resumeAttemptedRef.current) return;
    const jobId = searchParams.get("job");
    if (!jobId) return;
    resumeAttemptedRef.current = true;

    (async () => {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) return;
      const data = await res.json();
      setJob(data);
      if (data.status !== "done" && data.status !== "failed" && data.status !== "reviewing") {
        pollJob(jobId);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the (possibly machine-translated) segments into local editable
  // state once, the first time a job reaches "reviewing" — polling is
  // stopped at that point, so this won't clobber in-progress edits.
  useEffect(() => {
    if (job?.status === "reviewing" && segmentsInitRef.current !== job.id) {
      setSegments((job.translatedTranscript || []).map((s) => ({ ...s })));
      segmentsInitRef.current = job.id;
    }
  }, [job]);

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

  function updateSegment(index, patch) {
    setSegments((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError("");

    try {
      const patchRes = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: segments.map((s) => ({ translatedText: s.translatedText, voice: s.voice })),
        }),
      });
      if (!patchRes.ok) {
        const data = await patchRes.json().catch(() => ({}));
        setGenerateError(data.error || "저장에 실패했습니다.");
        setGenerating(false);
        return;
      }

      const genRes = await fetch(`/api/jobs/${job.id}/generate`, { method: "POST" });
      if (!genRes.ok) {
        const data = await genRes.json().catch(() => ({}));
        setGenerateError(data.error || "더빙 생성 요청에 실패했습니다.");
        setGenerating(false);
        return;
      }

      setJob((prev) => ({ ...prev, status: "dubbing" }));
      pollJob(job.id);
    } catch (err) {
      setGenerateError("서버 오류가 발생했습니다.");
    } finally {
      setGenerating(false);
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
      <h1>더빙 스튜디오</h1>

      {!job && (
        <>
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
        </>
      )}

      {job && (
        <div style={styles.jobBox}>
          <JobProgress status={job.status} errorMessage={job.errorMessage} />

          {job.status === "reviewing" && (
            <div style={styles.studio}>
              <p style={styles.studioHint}>
                번역이 완료됐습니다. 대사를 수정하고 세그먼트별로 목소리를 골라주세요.
              </p>

              {job.hasSource && (
                <video
                  src={`/api/jobs/${job.id}/source`}
                  controls
                  style={{ maxWidth: "100%", borderRadius: "8px" }}
                />
              )}

              <div style={styles.segmentList}>
                {segments.map((seg, i) => (
                  <div key={i} style={styles.segmentCard}>
                    <div style={styles.segmentMeta}>
                      {formatTime(seg.start)} - {formatTime(seg.end)}
                    </div>
                    <p style={styles.originalText}>{seg.text}</p>
                    <textarea
                      value={seg.translatedText}
                      onChange={(e) => updateSegment(i, { translatedText: e.target.value })}
                      rows={2}
                      style={styles.textarea}
                    />
                    <select
                      value={seg.voice}
                      onChange={(e) => updateSegment(i, { voice: e.target.value })}
                      style={styles.input}
                    >
                      {VOICE_CATEGORIES.map((category) => (
                        <optgroup key={category.key} label={category.label}>
                          {category.voices.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {generateError && <p style={{ color: "red" }}>{generateError}</p>}

              <button onClick={handleGenerate} disabled={generating} style={styles.generateButton}>
                {generating ? "요청 중..." : "더빙 생성"}
              </button>
            </div>
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
              {job.hasSubtitles && (
                <p>
                  <a href={`/api/jobs/${job.id}/srt`} download>
                    자막 다운로드 (SRT)
                  </a>
                </p>
              )}
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
    maxWidth: "640px",
    textAlign: "center",
  },
  studio: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    marginTop: "1.5rem",
    textAlign: "left",
  },
  studioHint: {
    textAlign: "center",
    color: "#555",
  },
  segmentList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  segmentCard: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    border: "1px solid #ddd",
    borderRadius: "8px",
    padding: "1rem",
    background: "#fafafa",
  },
  segmentMeta: {
    fontSize: "0.75rem",
    color: "#888",
    fontVariantNumeric: "tabular-nums",
  },
  originalText: {
    margin: 0,
    color: "#999",
    fontStyle: "italic",
    fontSize: "0.9rem",
  },
  textarea: {
    padding: "0.5rem",
    fontFamily: "inherit",
    fontSize: "0.95rem",
    resize: "vertical",
  },
  generateButton: {
    padding: "0.75rem",
    fontWeight: "bold",
    border: "1px solid #2f6f4f",
    background: "#2f6f4f",
    color: "#fff",
    borderRadius: "6px",
    cursor: "pointer",
  },
};
