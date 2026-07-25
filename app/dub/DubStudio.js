"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import JobProgress from "../components/JobProgress";
import { VOICE_CATEGORIES, DEFAULT_VOICE } from "../../lib/voices";
import { EMOTIONS, DEFAULT_EMOTION } from "../../lib/emotions";
import styles from "./DubStudio.module.css";

const CHARACTER_COLORS = ["#8b5cf6", "#34d399", "#f59e0b", "#ec4899", "#38bdf8", "#f87171"];

function defaultCharacters() {
  return [{ id: "c1", name: "화자 1", voice: DEFAULT_VOICE }];
}

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
  const [characters, setCharacters] = useState([]);
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

  // Load the (possibly machine-translated) segments + characters into local
  // editable state once, the first time a job reaches "reviewing" — polling
  // is stopped at that point, so this won't clobber in-progress edits.
  // Defensive fallback: a job that reached "reviewing" before this feature
  // shipped has no job.characters and segments without characterId/emotion —
  // fill in sensible defaults rather than crash.
  useEffect(() => {
    if (job?.status === "reviewing" && segmentsInitRef.current !== job.id) {
      const initialCharacters = job.characters?.length ? job.characters : defaultCharacters();
      setCharacters(initialCharacters);
      setSegments(
        (job.translatedTranscript || []).map((s) => ({
          ...s,
          characterId: s.characterId || initialCharacters[0].id,
          emotion: s.emotion || DEFAULT_EMOTION,
        }))
      );
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

  function addCharacter() {
    const id = crypto.randomUUID();
    setCharacters((prev) => [...prev, { id, name: `화자 ${prev.length + 1}`, voice: DEFAULT_VOICE }]);
  }

  function updateCharacter(id, patch) {
    setCharacters((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function deleteCharacter(id) {
    if (characters.length <= 1) return;
    const remaining = characters.filter((c) => c.id !== id);
    const fallbackId = remaining[0].id;
    setCharacters(remaining);
    setSegments((prev) =>
      prev.map((s) => (s.characterId === id ? { ...s, characterId: fallbackId } : s))
    );
  }

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError("");

    try {
      const patchRes = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characters,
          segments: segments.map((s) => ({
            translatedText: s.translatedText,
            characterId: s.characterId,
            emotion: s.emotion,
          })),
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
      <main className="page pageCentered">
        <p>이 기능을 사용하려면 로그인이 필요합니다.</p>
        <Link href="/login">로그인하러 가기</Link>
      </main>
    );
  }

  return (
    <main className="page">
      <div className={styles.header}>
        <h1 className={styles.title}>더빙 스튜디오</h1>
        {!job && <p className={styles.subtitle}>영상을 올리면 번역과 목소리를 직접 다듬을 수 있어요.</p>}
      </div>

      {!job && (
        <>
          <div className={styles.tabs}>
            <button
              onClick={() => setInputMode("upload")}
              className={inputMode === "upload" ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            >
              파일 업로드
            </button>
            <button
              onClick={() => setInputMode("youtube")}
              className={inputMode === "youtube" ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            >
              YouTube URL
            </button>
          </div>

          <form onSubmit={handleSubmit} className={styles.form}>
            {inputMode === "upload" ? (
              <div className={styles.fileInputWrap}>
                <input
                  type="file"
                  accept="video/*"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </div>
            ) : (
              <input
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
              />
            )}

            <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
              {LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}로 더빙
                </option>
              ))}
            </select>

            {error && <p className="errorText">{error}</p>}

            <button type="submit" disabled={submitting} className="button buttonPrimary">
              {submitting ? "제출 중..." : "더빙 시작"}
            </button>
          </form>
        </>
      )}

      {job && (
        <div className={styles.jobBox}>
          <JobProgress status={job.status} errorMessage={job.errorMessage} />

          {job.status === "reviewing" && (
            <div className={styles.studio}>
              <p className={styles.studioHint}>
                번역이 완료됐습니다. 대사를 수정하고 세그먼트별로 목소리를 골라주세요.
              </p>

              {job.hasSource && (
                <video src={`/api/jobs/${job.id}/source`} controls className={styles.video} />
              )}

              <div className={styles.characterSection}>
                <h2 className={styles.sectionTitle}>등장인물</h2>
                <div className={styles.characterList}>
                  {characters.map((c, i) => (
                    <div key={c.id} className={styles.characterRow}>
                      <span
                        className={styles.characterDot}
                        style={{ background: CHARACTER_COLORS[i % CHARACTER_COLORS.length] }}
                      />
                      <input
                        type="text"
                        value={c.name}
                        onChange={(e) => updateCharacter(c.id, { name: e.target.value })}
                        className={styles.characterNameInput}
                      />
                      <select
                        value={c.voice}
                        onChange={(e) => updateCharacter(c.id, { voice: e.target.value })}
                        className={styles.characterVoiceSelect}
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
                      <button
                        onClick={() => deleteCharacter(c.id)}
                        disabled={characters.length <= 1}
                        className={`button ${styles.iconButton}`}
                        title="삭제"
                      >
                        삭제
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={addCharacter} className="button">
                  + 등장인물 추가
                </button>
              </div>

              <div className={styles.segmentList}>
                {segments.map((seg, i) => {
                  const characterIndex = characters.findIndex((c) => c.id === seg.characterId);
                  return (
                    <div key={i} className={`card ${styles.segmentCard}`}>
                      <div className={styles.segmentMeta}>
                        {formatTime(seg.start)} - {formatTime(seg.end)}
                      </div>
                      <p className={styles.originalText}>{seg.text}</p>
                      <textarea
                        value={seg.translatedText}
                        onChange={(e) => updateSegment(i, { translatedText: e.target.value })}
                        rows={2}
                        className={styles.textarea}
                      />
                      <div className={styles.segmentSelectRow}>
                        <div className={styles.characterSelectWrap}>
                          <span
                            className={styles.characterDot}
                            style={{
                              background:
                                CHARACTER_COLORS[
                                  (characterIndex < 0 ? 0 : characterIndex) % CHARACTER_COLORS.length
                                ],
                            }}
                          />
                          <select
                            value={seg.characterId}
                            onChange={(e) => updateSegment(i, { characterId: e.target.value })}
                          >
                            {characters.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <select
                          value={seg.emotion}
                          onChange={(e) => updateSegment(i, { emotion: e.target.value })}
                        >
                          {EMOTIONS.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>

              {generateError && <p className="errorText">{generateError}</p>}

              <button onClick={handleGenerate} disabled={generating} className="button buttonPrimary">
                {generating ? "요청 중..." : "더빙 생성"}
              </button>
            </div>
          )}

          {job.status === "done" && job.hasOutput && (
            <div className={styles.doneBlock}>
              <video src={`/api/jobs/${job.id}/video`} controls className={styles.video} />
              <div className={styles.downloadLinks}>
                <a href={`/api/jobs/${job.id}/video`} download>
                  더빙된 영상 다운로드
                </a>
                {job.hasSubtitles && (
                  <a href={`/api/jobs/${job.id}/srt`} download>
                    자막 다운로드 (SRT)
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
