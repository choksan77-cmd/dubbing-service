// Pure data module — no Node built-ins or SDK imports here. This file is
// imported by both server code (lib/pipeline.js, API routes) and client
// components (the studio UI's voice picker), so it must stay a safe leaf
// module or the client bundle build breaks.

export const VOICE_CATEGORIES = [
  {
    key: "male",
    label: "남성",
    voices: [
      { id: "onyx", label: "중후한 남성 (onyx)" },
      { id: "echo", label: "또렷한 남성 (echo)" },
      { id: "ash", label: "명료한 남성 (ash)" },
      { id: "verse", label: "표현력 있는 남성 (verse)" },
    ],
  },
  {
    key: "female",
    label: "여성",
    voices: [
      { id: "nova", label: "밝고 젊은 여성 (nova)" },
      { id: "shimmer", label: "경쾌한 여성 (shimmer)" },
      { id: "coral", label: "따뜻한 여성 (coral)" },
      { id: "sage", label: "차분하고 연륜있는 여성 (sage)" },
    ],
  },
  {
    key: "neutral",
    label: "중성",
    voices: [
      { id: "alloy", label: "중립적인 목소리 (alloy)" },
      { id: "fable", label: "부드러운 중성 (fable)" },
      { id: "ballad", label: "선율적이고 부드러운 (ballad)" },
    ],
  },
  {
    key: "premium",
    label: "프리미엄",
    voices: [
      { id: "marin", label: "자연스럽고 친근한 (marin)" },
      { id: "cedar", label: "안정적이고 차분한 (cedar)" },
    ],
  },
];

export const VOICES = VOICE_CATEGORIES.flatMap((category) => category.voices);

export const DEFAULT_VOICE = "alloy";

export function isValidVoice(id) {
  return VOICES.some((v) => v.id === id);
}
