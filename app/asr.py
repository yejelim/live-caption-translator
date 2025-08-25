# app/asr.py
import os
from io import BytesIO
from typing import Dict, Any
from openai import OpenAI, BadRequestError
from tenacity import retry, stop_after_attempt, wait_fixed

_WHISPER_MODEL = os.getenv("ASR_MODEL", "whisper-1")
_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

@retry(stop=stop_after_attempt(3), wait=wait_fixed(0.4))
def _whisper_call(model: str, fileobj: BytesIO):
    # fileobj.name 이 확실히 존재해야 SDK가 포맷(webm/ogg/wav 등)을 잘 인식함
    return _client.audio.transcriptions.create(
        model=model,
        file=fileobj,
        response_format="verbose_json",
    )

def transcribe_chunk(audio_bytes: bytes, *, filename: str = "chunk.webm") -> Dict[str, Any]:
    """
    업로드 원본 바이트를 BytesIO로 감싸서 OpenAI로 전송.
    filename 확장자로 포맷(webm/ogg/wav/mp3 등) 추론을 돕는다.
    """
    if not audio_bytes or len(audio_bytes) < 100:  # 너무 작으면 대부분 빈 청크
        raise ValueError("Empty or too-small audio chunk")

    bio = BytesIO(audio_bytes)
    bio.name = filename  # 굉장히 중요!

    try:
        resp = _whisper_call(_WHISPER_MODEL, bio)
    except BadRequestError as e:
        # 예: Invalid file format, decode 실패 등
        raise ValueError(getattr(e, "message", str(e)))

    out = {
        "text": getattr(resp, "text", "") or "",
        "segments": [],
    }
    for s in getattr(resp, "segments", []) or []:
        out["segments"].append({
            "start": float(getattr(s, "start", 0.0) or 0.0),
            "end": float(getattr(s, "end", 0.0) or 0.0),
            "text": getattr(s, "text", "") or "",
        })
    return out
