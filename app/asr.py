# app/asr.py
import os
from io import BytesIO
from typing import Dict, Any
from openai import OpenAI, BadRequestError
from tenacity import retry, stop_after_attempt, wait_fixed, RetryError
import subprocess

_WHISPER_MODEL = os.getenv("ASR_MODEL", "whisper-1")
_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def _bytesio_named(b: bytes, name: str) -> BytesIO:
    bio = BytesIO(b)
    bio.name = name  # 파일 확장자로 포맷 추론에 매우 중요
    return bio

@retry(stop=stop_after_attempt(3), wait=wait_fixed(0.4))
def _whisper_call(model: str, fileobj: BytesIO):
    return _client.audio.transcriptions.create(
        model=model,
        file=fileobj,
        response_format="verbose_json",
    )

def _to_wav_ffmpeg(src_bytes: bytes) -> bytes:
    """
    webm/ogg 등 문제있는 컨테이너를 FFmpeg로 WAV(16kHz/mono)로 변환.
    FFmpeg가 설치되어 있어야 함 (macOS: `brew install ffmpeg`).
    """
    cmd = [
        "ffmpeg",
        "-hide_banner", "-loglevel", "error",
        "-y", "-i", "pipe:0",
        "-f", "wav", "-ac", "1", "-ar", "16000",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, input=src_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not proc.stdout:
        err = proc.stderr.decode(errors="ignore") if proc.stderr else "unknown"
        raise ValueError(f"ffmpeg transcode failed: {err}")
    return proc.stdout

def _transcribe_or_raise(b: bytes, filename: str) -> Dict[str, Any]:
    try:
        resp = _whisper_call(_WHISPER_MODEL, _bytesio_named(b, filename))
    except (BadRequestError, RetryError) as e:
        # RetryError 래핑을 풀어 메시지 확보
        msg = ""
        if isinstance(e, RetryError):
            last = e.last_attempt.exception() if hasattr(e, "last_attempt") else None
            msg = getattr(last, "message", str(last)) if last else str(e)
        else:
            msg = getattr(e, "message", str(e))
        raise ValueError(f"primary transcribe failed: {msg}")

    out: Dict[str, Any] = {"text": getattr(resp, "text", "") or "", "segments": []}
    for s in getattr(resp, "segments", []) or []:
        out["segments"].append({
            "start": float(getattr(s, "start", 0.0) or 0.0),
            "end": float(getattr(s, "end", 0.0) or 0.0),
            "text": getattr(s, "text", "") or "",
        })
    return out

def transcribe_chunk(audio_bytes: bytes, *, filename: str = "chunk.webm") -> Dict[str, Any]:
    """
    1차: 업로드 포맷 그대로 전송 (BytesIO.name=filename)
    2차: 실패 시 ffmpeg로 WAV 변환해서 재시도
    """
    if not audio_bytes or len(audio_bytes) < 100:
        raise ValueError("Empty or too-small audio chunk")

    # 1차 시도 (원본 webm/ogg/wav 등)
    try:
        return _transcribe_or_raise(audio_bytes, filename)
    except ValueError as first_err:
        # 2차: FFmpeg로 WAV 변환 후 재시도
        try:
            wav = _to_wav_ffmpeg(audio_bytes)
            return _transcribe_or_raise(wav, "chunk.wav")
        except Exception as second_err:
            raise ValueError(
                f"ASR failed. primary={first_err}; fallback={second_err}"
            )
