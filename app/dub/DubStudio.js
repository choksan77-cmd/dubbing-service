"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import JobProgress from "../components/JobProgress";
import Timeline from "./Timeline";
import SegmentFields from "./SegmentFields";
import CharacterPanel from "./CharacterPanel";
import { DEFAULT_VOICE } from "../../lib/voices";
import { DEFAULT_EMOTION } from "../../lib/emotions";
import { DEFAULT_VOICE_STYLE } from "../../lib/voiceStyles";
import styles from "./DubStudio.module.css";

const CHARACTER_COLORS = ["#8b5cf6", "#34d399", "#f59e0b", "#ec4899", "#38bdf8", "#f87171"];

function defaultCharacters() {
  return [{ id: "c1", name: "화자 1", voice: DEFAULT_VOICE, style: DEFAULT_VOICE_STYLE }];
}

const LANGUAGES = [
  { value: "English", label: "영어" },
  { value: "Korean", label: "한국어" },
  { value: "Japanese", label: "일본어" },
  { value: "Chinese", label: "중국어" },
  { value: "Spanish", label: "스페인어" },
];

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [reopenError, setReopenError] = useState("");

  const pollRef = useRef(null);
  const segmentsInitRef = useRef(null);
  const resumeAttemptedRef = useRef(false);
  const videoRef = useRef(null);

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
      setSelectedIndex(0);
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

  function selectSegment(i) {
    setSelectedIndex(i);
    if (videoRef.current && segments[i]) {
      videoRef.current.currentTime = segments[i].start;
    }
  }

  function addCharacter() {
    const id = crypto.randomUUID();
    setCharacters((prev) => [
      ...prev,
      { id, name: `화자 ${prev.length + 1}`, voice: DEFAULT_VOICE, style: DEFAULT_VOICE_STYLE },
    ]);
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

  async function handleReopen() {
    setReopenError("");
    const res = await fetch(`/api/jobs/${job.id}/reopen`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setReopenError(data.error || "다시 수정하기에 실패했습니다.");
      return;
    }
    setJob((prev) => ({ ...prev, status: "reviewing" }));
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
            <div className={styles.editor}>
              {job.hasSource && (
                <video
                  ref={videoRef}
                  src={`/api/jobs/${job.id}/source`}
                  controls
                  className={styles.video}
                  onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                />
              )}

              <Timeline
                segments={segments}
                characters={characters}
                colors={CHARACTER_COLORS}
                duration={videoDuration}
                currentTime={currentTime}
                selectedIndex={selectedIndex}
                onSelect={selectSegment}
              />

              <div className={styles.editorColumns}>
                <CharacterPanel
                  characters={characters}
                  colors={CHARACTER_COLORS}
                  onAdd={addCharacter}
                  onUpdate={updateCharacter}
                  onDelete={deleteCharacter}
                />
                <SegmentFields
                  segment={segments[selectedIndex]}
                  index={selectedIndex}
                  total={segments.length}
                  characters={characters}
                  onChange={(patch) => updateSegment(selectedIndex, patch)}
                  onPrev={() => selectSegment(Math.max(0, selectedIndex - 1))}
                  onNext={() => selectSegment(Math.min(segments.length - 1, selectedIndex + 1))}
                />
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
              {reopenError && <p className="errorText">{reopenError}</p>}
              <button onClick={handleReopen} className="button">
                다시 수정하기
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
