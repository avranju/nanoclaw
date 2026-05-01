---
name: malayalam-translator
description: Translates English text into colloquial spoken Malayalam, with both the Malayalam script output and a Roman-script transliteration. Use this skill whenever the user wants to translate English to Malayalam, render something in Malayalam, ask how to say something in Malayalam, or wants a transliteration of Malayalam text. Trigger even for casual requests like "how do I say X in Malayalam?" or "write this in Malayalam". Always prefer colloquial, everyday spoken Malayalam (the kind used in normal conversation in Kerala) over formal/literary Malayalam — unless the user explicitly asks for formal register.
---

# Malayalam Translator

Translate English text into **colloquial spoken Malayalam** — the kind of natural, everyday language used in homes and casual conversation in Kerala, not textbook or literary Malayalam.

## Output Format

Always produce **three parts** in this exact order:

### 1. Translation note (brief)
A one-line explanation of any register choices, dialect notes, or anything the user should know (e.g., "Using casual Thrissur-region colloquial style" or "Softened for polite register since it's a request").

### 2. Malayalam script — in a SEPARATE message block
Send the Malayalam script text in its own clearly demarcated block so it can be easily copied. Use a code block or a clearly labelled section. Example:

---
**Malayalam:**

```
നിനക്ക് എന്താ പ്രശ്നം?
```
---

### 3. Transliteration
Romanized phonetic rendering immediately below, using intuitive English approximations. Mark stress with capital letters where helpful. Example:

**Transliteration:** *Ninakk enthaa pra-shnam?*

---

## Translation Guidelines

### Register and Style
- Default to **casual, colloquial Malayalam** — contractions, elisions, and everyday spoken forms.
- Avoid overly Sanskritized or formal vocabulary unless asked.
- Use common spoken-form elisions:
  - "എന്ത്" not "എന്ത്" in full formal form — use "എന്താ", "എന്ത്", etc. as context fits
  - "ഒക്കെ" (okke) for "all/everything"
  - "ആണ്" → often shortened to "ആ" in speech
  - "ഇല്ല" → "ഇല്ല" (stays, but flow changes in speech)
- Contractions like "നിനക്ക്" (you, casual) vs "നിങ്ങൾക്ക്" (you, respectful) — choose based on context.

### Pronoun and Politeness Register
- For general/neutral context: use casual second person "നിനക്ക്" / "നീ"
- For clearly formal/professional context: use "നിങ്ങൾ"
- Note the choice made in the translation note.

### Common Colloquialisms to Prefer
| Formal/Literary | Colloquial |
|---|---|
| എന്ത് | എന്താ / എന്ത് |
| ഇവിടെ | ഇവ്ടെ |
| അവിടെ | അവ്ടെ |
| ഉണ്ടോ | ഉണ്ടോ (stays) |
| പോകുന്നു | പോകുന്നു → പോണ്, പോകേ |
| ഭക്ഷണം | ഊണ് (for a meal/food colloquially) |
| ആഗ്രഹം | മോഹം (casual desire) |

### Transliteration Conventions
- "ക" → k, "ഖ" → kh, "ഗ" → g
- "ച" → ch, "ജ" → j
- "ട" → t (retroflex), "ത" → th (dental)
- "ണ" → n (retroflex), "ന" → n
- "ള" → l (retroflex), "ല" → l
- "ഴ" → zh (the distinctive Malayalam sound)
- "ശ" → sh, "ഷ" → sh, "സ" → s
- Long vowels: "ആ" → aa, "ഈ" → ee, "ഊ" → oo
- Anusvara/chillu nasals: use "m" or "n" based on pronunciation

---

## Example

**Input:** "What's the problem with you?"

**Translation note:** Casual register, slightly exasperated tone preserved.

**Malayalam:**
```
നിനക്ക് എന്താ പ്രശ്നം?
```

**Transliteration:** *Ninakk enthaa pra-shnam?*

---

## Edge Cases

- **Idioms**: Don't translate literally — find the Malayalam equivalent idiom or natural expression.
- **No direct equivalent**: Explain briefly and offer the closest natural expression.
- **Multiple valid translations**: Offer 1–2 alternatives if meaningfully different.
- **Long passages**: Translate in full, maintain paragraph breaks.
