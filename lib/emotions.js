// Pure data module — same leaf-module constraint as lib/voices.js (no Node
// built-ins or SDK imports), since this is imported by both server code and
// client components.

// Keep instructions focused on tone/pitch/energy quality only — anything
// that asks for slower pacing, added pauses, or drawn-out delivery (an
// earlier version of "sad"/"crying" did this) measurably lengthens the
// synthesized audio, which pushes it further past its original time slot
// and makes the atempo-capped drift (and therefore sync vs. the video)
// worse, not better. Real user report: strengthening these for more
// emotional "color" made sync noticeably worse than the flatter originals.
export const EMOTIONS = [
  { id: "neutral", label: "기본", instructions: null },
  {
    id: "calm",
    label: "차분한",
    instructions: "Speak in a calm, gentle, soft-spoken tone quality, at a normal pace.",
  },
  {
    id: "angry",
    label: "화난",
    instructions:
      "Speak in an angry, intense, sharp-edged tone quality — real irritation and force in the voice, at a normal or slightly brisk pace, not drawn out.",
  },
  {
    id: "crying",
    label: "울먹이는",
    instructions:
      "Speak with a trembling, wavering, choked-up voice quality, as if fighting back tears, at a normal pace.",
  },
  {
    id: "happy",
    label: "기쁜",
    instructions: "Speak in a bright, energetic, upbeat tone quality, at a normal or brisk pace.",
  },
  {
    id: "sad",
    label: "슬픈",
    instructions: "Speak in a heavy, downcast, weary tone quality, at a normal pace.",
  },
];

export const DEFAULT_EMOTION = "neutral";

export function isValidEmotion(id) {
  return EMOTIONS.some((e) => e.id === id);
}

export function getEmotionInstructions(id) {
  return EMOTIONS.find((e) => e.id === id)?.instructions || null;
}
