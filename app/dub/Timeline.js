"use client";

import styles from "./Timeline.module.css";

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Timeline({
  segments,
  characters,
  colors,
  duration,
  currentTime,
  selectedIndex,
  onSelect,
}) {
  const safeDuration = duration > 0 ? duration : 1;

  return (
    <div className={styles.wrap}>
      <div className={styles.track}>
        {segments.map((seg, i) => {
          const characterIndex = characters.findIndex((c) => c.id === seg.characterId);
          const color = colors[(characterIndex < 0 ? 0 : characterIndex) % colors.length];
          const left = (seg.start / safeDuration) * 100;
          const width = Math.max(((seg.end - seg.start) / safeDuration) * 100, 0.3);
          return (
            <div
              key={i}
              onClick={() => onSelect(i)}
              className={`${styles.block} ${i === selectedIndex ? styles.blockSelected : ""}`}
              style={{ left: `${left}%`, width: `${width}%`, background: color }}
              title={seg.translatedText}
            />
          );
        })}
        <div
          className={styles.playhead}
          style={{ left: `${Math.min((currentTime / safeDuration) * 100, 100)}%` }}
        />
      </div>
      <div className={styles.timeLabels}>
        <span>0:00</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
