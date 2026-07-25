// Pure data module — same leaf-module constraint as lib/voices.js (no Node
// built-ins or SDK imports), since this is imported by both server code and
// client components.

export const EMOTIONS = [
  { id: "neutral", label: "기본", instructions: null },
  { id: "calm", label: "차분한", instructions: "Speak in a calm, measured, gentle tone." },
  { id: "angry", label: "화난", instructions: "Speak in an angry, frustrated, raised tone." },
  {
    id: "crying",
    label: "울먹이는",
    instructions: "Speak as if on the verge of tears, in a trembling, sorrowful voice.",
  },
  { id: "happy", label: "기쁜", instructions: "Speak in a bright, joyful, upbeat tone." },
  { id: "sad", label: "슬픈", instructions: "Speak in a sad, subdued, downcast tone." },
];

export const DEFAULT_EMOTION = "neutral";

export function isValidEmotion(id) {
  return EMOTIONS.some((e) => e.id === id);
}

export function getEmotionInstructions(id) {
  return EMOTIONS.find((e) => e.id === id)?.instructions || null;
}
