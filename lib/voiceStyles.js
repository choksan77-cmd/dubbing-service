// Pure data module — same leaf-module constraint as lib/voices.js and
// lib/emotions.js. OpenAI's TTS voices have no age variation built in (13
// fixed voices, no "child"/"elderly" option) — this is the honest workaround:
// steer age/character via the `instructions` param on top of a base voice,
// combined with per-line emotion at synthesis time.

export const VOICE_STYLES = [
  { id: "none", label: "기본", instructions: null },
  {
    id: "child",
    label: "아이 같은",
    instructions:
      "You are voicing a young child, roughly 5-8 years old. This must sound clearly, unmistakably like a small child — not an adult. Pitch your voice noticeably higher than a normal adult voice, speak quickly and energetically, with a light, playful, slightly sing-song rhythm.",
  },
  {
    id: "young",
    label: "젊은",
    instructions:
      "You are voicing a person in their early 20s. Speak with a bright, light, youthful voice quality, a bit faster-paced and energetic, clearly younger-sounding than a middle-aged adult.",
  },
  {
    id: "elderly",
    label: "나이든",
    instructions:
      "You are voicing an elderly person in their 70s-80s. This must sound clearly, unmistakably old — not just calm. Speak noticeably slower than normal with a frail, slightly shaky, raspy voice, occasional slight breathiness, and a lower, more worn vocal quality, the way a grandparent speaks.",
  },
  {
    id: "gruff",
    label: "걸걸한",
    instructions:
      "Speak with a gruff, gravelly, rough, low-pitched voice quality, like someone who smokes and speaks bluntly.",
  },
];

export const DEFAULT_VOICE_STYLE = "none";

export function isValidVoiceStyle(id) {
  return VOICE_STYLES.some((s) => s.id === id);
}

export function getVoiceStyleInstructions(id) {
  return VOICE_STYLES.find((s) => s.id === id)?.instructions || null;
}
