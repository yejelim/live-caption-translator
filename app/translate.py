import os
from openai import OpenAI

_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
_LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

_SYSTEM = (
    "You are a professional EN-KO translator for academic/technnical speech."
    "Translate concisely and naturally into polite Korean."
)

def translate_text(english_text: str) -> str:
    if not english_text:
        return ""
    resp = _client.chat.completions.create(
        model=_LLM_MODEL,
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": f"Translate into Korean:\n{english_text}"}
        ],
        temperature=0.2,
    )
    return (resp.choices[0].message.content or "").strip()