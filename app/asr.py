import os
from io import BytesIO
from typing import Dict, List
from openai import OpenAI
from tenacity import retry, wait_exponential, stop_after_attempt

_WHISPER_MODEL = os.getenv("WHISPER_MODEL", "whisper-1")

@retry(wait=wait_exponential(multiplier=1, min=1, max=8), stop=stop_after_attempt(3))
def _whisper_call(model: str, file_tuple) -> object:
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return client.audio.transcriptions.create(
        model=model,
        file=file_tuple,
        response_format="verbose_json",
    )

def transcribe_chunk(audio_bytes: bytes) -> Dict:
    if not audio_bytes:
        return {"text": "", "segments": []}

    buf = BytesIO(audio_bytes)
    resp = _whisper_call(_WHISPER_MODEL, ("chunk.wav", buf, "audio/wav"))

    text = (getattr(resp, "text", "") or "").strip()

    segments: List[Dict] = []
    raw_segments = getattr(resp, "segments", None)
    if raw_segments:
        for s in raw_segments:
            d = s.dict() if hasattr(s, "dict") else dict(s)
            segments.append({
                "start": float(d.get("start", 0.0)),
                "end": float(d.get("end", 0.0)),
                "text": (d.get("text", "") or "").strip()
            })

    return {"text": text, "segments": segments}
