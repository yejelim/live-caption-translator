# app/asr.py
import os
from typing import Dict, Any, Tuple, Optional
from openai import OpenAI
from openai import BadRequestError
from tenacity import retry, stop_after_attempt, wait_fixed

# ASR 모델은 환경변수로 선택 가능 (기본: whisper-1)
_WHISPER_MODEL = os.getenv("ASR_MODEL", "whisper-1")

_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def _file_tuple_from_bytes(
    b: bytes,
    filename: str = "chunk.webm",
    mime: str = "audio/webm",
) -> Tuple[str, bytes, str]:
    """
    OpenAI audio API가 받는 (filename, bytes, content_type) 튜플을 만듭니다.
    """
    return (filename, b, mime)

@retry(stop=stop_after_attempt(3), wait=wait_fixed(0.5))
def _whisper_call(model: str, file_tuple: Tuple[str, bytes, str]) -> Any:
    """
    OpenAI Transcriptions API 호출 (verbose_json으로 세그먼트를 함께 반환).
    webm/opus를 그대로 전달합니다.
    """
    return _client.audio.transcriptions.create(
        model=model,
        file=file_tuple,
        response_format="verbose_json",  # segments 포함
        # language="en",  # 필요 시 고정
        # prompt="...",   # 도메인 프롬프트 활용 시
    )

def transcribe_chunk(audio_bytes: bytes, *, mime: Optional[str] = None, filename: Optional[str] = None) -> Dict[str, Any]:
    """
    업로드된 원본 바이트를 webm 그대로 OpenAI로 전송해 텍스트/세그먼트를 반환.
    - mime/filename이 넘어오면 그대로 사용 (기본은 audio/webm / chunk.webm)
    """
    _mime = mime or "audio/webm"
    _filename = filename or ("chunk.webm" if _mime.startswith("audio/webm") else "chunk.bin")
    ft = _file_tuple_from_bytes(audio_bytes, filename=_filename, mime=_mime)

    try:
        resp = _whisper_call(_WHISPER_MODEL, ft)
    except BadRequestError as e:
        # 상위에서 처리할 수 있도록 의미있는 메시지로 재랭글
        raise ValueError(f"ASR decode failed: {getattr(e, 'message', str(e))}")

    # whisper-1 verbose_json 포맷 가정
    # resp.text, resp.segments (start, end, text 등)을 반환
    out = {
        "text": getattr(resp, "text", "") or "",
        "segments": [],
    }
    segs = getattr(resp, "segments", None) or []
    for s in segs:
        # 일부 필드만 추려서 반환
        out["segments"].append({
            "start": float(getattr(s, "start", 0.0) or 0.0),
            "end": float(getattr(s, "end", 0.0) or 0.0),
            "text": getattr(s, "text", "") or "",
        })
    return out
