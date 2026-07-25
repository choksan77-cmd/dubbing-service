"use client";

import { EMOTIONS } from "../../lib/emotions";
import styles from "./SegmentFields.module.css";

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function SegmentFields({
  segment,
  index,
  total,
  characters,
  onChange,
  onPrev,
  onNext,
}) {
  if (!segment) return null;

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.meta}>
        {formatTime(segment.start)} - {formatTime(segment.end)} · {index + 1} / {total}
      </div>
      <p className={styles.originalText}>{segment.text}</p>
      <textarea
        value={segment.translatedText}
        onChange={(e) => onChange({ translatedText: e.target.value })}
        rows={3}
        className={styles.textarea}
      />
      <div className={styles.selectRow}>
        <select
          value={segment.characterId}
          onChange={(e) => onChange({ characterId: e.target.value })}
        >
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={segment.emotion} onChange={(e) => onChange({ emotion: e.target.value })}>
          {EMOTIONS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.nav}>
        <button onClick={onPrev} disabled={index <= 0} className="button">
          이전 대사
        </button>
        <button onClick={onNext} disabled={index >= total - 1} className="button">
          다음 대사
        </button>
      </div>
    </div>
  );
}
