# app/asr.py
import os
from io import BytesIO
from openai import OpenAI

_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
_WHISPER_MODEL = os.getenv("WHISPER_MODEL", "whisper-1")

def transcribe_chunk(audio_bytes: bytes) -> dict:
    """
    Returns:
      {
        "text": "...",
        "segments": [{"start": float, "end": float, "text": "..."} ...]
      }
    """
    if not audio_bytes:
        return {"text": "", "segments": []}
    buf = BytesIO(audio_bytes)
    resp = _client.audio.transcriptions.create(
        model=_WHISPER_MODEL,
        file=("chunk.wav", buf, "audio/wav"),
        response_format="verbose_json"
    )

    # openai>=1.40 응답에서 segments 접근 방식 호환 처리
    segments = []
    raw_segments = getattr(resp, "segments", None)
    if raw_segments:
        for s in raw_segments:
            d = s.dict() if hasattr(s, "dict") else dict(s)
            segments.append({
                "start": float(d.get("start", 0.0)),
                "end": float(d.get("end", 0.0)),
                "text": d.get("text", "").strip()
            })
    return {"text": (resp.text or "").strip(), "segments": segments}
