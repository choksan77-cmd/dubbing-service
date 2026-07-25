// Pure data module — same leaf-module constraint as lib/voices.js (no Node
// built-ins or SDK imports), since this is imported by both server code and
// client components.

export const EMOTIONS = [
  { id: "neutral", label: "기본", instructions: null },
  {
    id: "calm",
    label: "차분한",
    instructions: "Deliver this in a calm, measured, gentle tone — relaxed pacing, soft dynamics.",
  },
  {
    id: "angry",
    label: "화난",
    instructions:
      "This line is SHOUTED in anger. Deliver it with real emotional intensity — loud, sharp, clipped, aggressive delivery, like someone furious and losing their temper, not a calm or flat reading. Push the volume and intensity up noticeably.",
  },
  {
    id: "crying",
    label: "울먹이는",
    instructions:
      "This person is crying while speaking. Deliver it with a trembling, breaking voice, choked up, wavering pitch, audible sobbing quality — clearly emotionally distressed, not composed.",
  },
  {
    id: "happy",
    label: "기쁜",
    instructions:
      "This line is full of genuine excitement and joy. Deliver it with an energetic, bright, smiling voice quality, noticeably upbeat pacing — not flat or reserved.",
  },
  {
    id: "sad",
    label: "슬픈",
    instructions:
      "This line is heavy with sadness. Deliver it slowly, quietly, with a heavy, downcast, weary voice quality — clearly sorrowful, not neutral.",
  },
];

export const DEFAULT_EMOTION = "neutral";

export function isValidEmotion(id) {
  return EMOTIONS.some((e) => e.id === id);
}

export function getEmotionInstructions(id) {
  return EMOTIONS.find((e) => e.id === id)?.instructions || null;
}
