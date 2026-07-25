"use client";

import { VOICE_CATEGORIES } from "../../lib/voices";
import { VOICE_STYLES } from "../../lib/voiceStyles";
import styles from "./CharacterPanel.module.css";

export default function CharacterPanel({
  characters,
  colors,
  onAdd,
  onUpdate,
  onDelete,
}) {
  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>등장인물</h2>
      <div className={styles.list}>
        {characters.map((c, i) => (
          <div key={c.id} className={styles.row}>
            <div className={styles.rowTop}>
              <span
                className={styles.dot}
                style={{ background: colors[i % colors.length] }}
              />
              <input
                type="text"
                value={c.name}
                onChange={(e) => onUpdate(c.id, { name: e.target.value })}
                className={styles.nameInput}
              />
              <button
                onClick={() => onDelete(c.id)}
                disabled={characters.length <= 1}
                className="button"
              >
                삭제
              </button>
            </div>
            <div className={styles.selectRow}>
              <select value={c.voice} onChange={(e) => onUpdate(c.id, { voice: e.target.value })}>
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
              <select value={c.style} onChange={(e) => onUpdate(c.id, { style: e.target.value })}>
                {VOICE_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
      <button onClick={onAdd} className="button">
        + 등장인물 추가
      </button>
    </div>
  );
}
