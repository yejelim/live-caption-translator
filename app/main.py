# 1) .env는 가장 먼저 로드
from dotenv import load_dotenv
load_dotenv()

import os
import re
from pathlib import Path
from datetime import datetime
import uuid
import shutil
from io import BytesIO
import asyncio
import json

# 환경변수 검증
required_env_vars = ["OPENAI_API_KEY"]
missing_vars = [var for var in required_env_vars if not os.getenv(var)]
if missing_vars:
    raise ValueError(f"Missing required environment variables: {', '.join(missing_vars)}")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, UploadFile, File, Form, Request
from fastapi.responses import PlainTextResponse, StreamingResponse, HTMLResponse, FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware

from app.asr import transcribe_chunk
from app.translate import translate_text
from app.session import SESSION
from app.exporters import build_docx

# ─────────────────────────────────────────────────────────────
# FastAPI
# ─────────────────────────────────────────────────────────────
app = FastAPI(title="Live Caption Translator", version="0.1.0")

# CORS: 개발에서 자주 쓰는 포트/도메인 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3002",
        "http://localhost:5173",  # Vite default
        "http://127.0.0.1:5173",
        "http://localhost:8080",  # Vue CLI default
        "http://127.0.0.1:8080",
    ],
    allow_origin_regex=r"http://localhost:\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────
# 유틸
# ─────────────────────────────────────────────────────────────
def clean_en(s: str) -> str:
    if not s:
        return s
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\.{3,}$", ".", s)
    if len(s) > 40 and not re.search(r"[.!?]$", s):
        s += "."
    return s

def r2(x: float) -> float:
    return float(f"{x:.2f}")

DATA_DIR = Path("data")
(DATA_DIR / "sessions").mkdir(parents=True, exist_ok=True)
(DATA_DIR / "exports").mkdir(parents=True, exist_ok=True)

SESSION_TIMELINE = {}  # session_id -> float (HTTP 청크용 글로벌 타임라인)

# ─────────────────────────────────────────────────────────────
# 최소–최대 윈도우 버퍼
# ─────────────────────────────────────────────────────────────
class CaptionBuffer:
    def __init__(self, min_window_sec: float = 8.0, max_window_sec: float = 12.0, min_chars: int = 20):
        assert max_window_sec >= min_window_sec
        self.min_window = min_window_sec
        self.max_window = max_window_sec
        self.min_chars = min_chars
        self.reset()

    def reset(self):
        self.en_parts = []
        self.t0 = None
        self.t1 = None
        self.accum_sec = 0.0

    def add(self, seg_t0: float, seg_t1: float, text_en: str):
        if not text_en:
            return
        if self.t0 is None:
            self.t0 = seg_t0
        self.t1 = seg_t1
        self.accum_sec += max(0.0, (seg_t1 or 0.0) - (seg_t0 or 0.0))
        self.en_parts.append(text_en.strip())

    def _joined_en(self) -> str:
        return " ".join(self.en_parts).strip()

    def _ends_with_punct(self, s: str) -> bool:
        return s.endswith((".", "?", "!"))

    def ready(self) -> bool:
        en = self._joined_en()
        if len(en) < self.min_chars:
            return False
        if self.accum_sec >= self.max_window:
            return True
        if self.accum_sec >= self.min_window and self._ends_with_punct(en):
            return True
        return False

    def flush(self):
        en = self._joined_en()
        if en and not self._ends_with_punct(en) and len(en) > 40:
            en += "."
        seg = (self.t0 or 0.0, self.t1 or 0.0)
        self.reset()
        return seg, en

# ─────────────────────────────────────────────────────────────
# SSE 브로커 & 버퍼 캐시 (세션별)
# ─────────────────────────────────────────────────────────────
class EventBroker:
    def __init__(self):
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()
        self._msg_id = 0

    async def subscribe(self, session_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        async with self._lock:
            self._subs.setdefault(session_id, set()).add(q)
        return q

    async def unsubscribe(self, session_id: str, q: asyncio.Queue):
        async with self._lock:
            if session_id in self._subs:
                self._subs[session_id].discard(q)
                if not self._subs[session_id]:
                    del self._subs[session_id]

    async def publish(self, session_id: str, event_type: str, data: dict):
        async with self._lock:
            qs = list(self._subs.get(session_id, []))
            self._msg_id += 1
            msg = {"type": event_type, "data": data, "id": self._msg_id}
        for q in qs:
            try:
                q.put_nowait(msg)
            except Exception:
                pass

BROKER = EventBroker()
BUFFERS: dict[str, CaptionBuffer] = {}  # session_id -> CaptionBuffer

# ─────────────────────────────────────────────────────────────
# 헬스/인덱스
# ─────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"ok": True}

@app.get("/", response_class=HTMLResponse)
def index():
    return """
    <!doctype html>
    <html>
    <head><meta charset="utf-8"><title>Live Caption Translator</title></head>
    <body style="font-family: system-ui, -apple-system, sans-serif; padding: 24px; line-height: 1.5;">
      <h1>Live Caption Translator</h1>
      <ul>
        <li>Health: <a href="/health">/health</a></li>
        <li>API Docs (Swagger): <a href="/docs">/docs</a></li>
        <li>WebSocket: <code>ws://localhost:8000/ws/stream?session_id=demo</code></li>
        <li>SSE events: <code>/events?session_id=&lt;id&gt;</code></li>
        <li>Export (legacy GET): <code>/export/&lt;session_id&gt;?format=txt|docx|srt</code></li>
      </ul>
    </body>
    </html>
    """

# ─────────────────────────────────────────────────────────────
# SSE (서버 푸시)
# ─────────────────────────────────────────────────────────────
@app.get("/events")
async def sse_events(request: Request, session_id: str):
    async def gen():
        q = await BROKER.subscribe(session_id)
        try:
            # handshake
            yield "event: ping\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30.0)
                    payload = (
                        f"event: {msg['type']}\n"
                        f"id: {msg['id']}\n"
                        f"data: {json.dumps(msg['data'], ensure_ascii=False)}\n\n"
                    )
                    yield payload
                except asyncio.TimeoutError:
                    # keep-alive comment
                    yield ": keep-alive\n\n"
        finally:
            await BROKER.unsubscribe(session_id, q)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # nginx 버퍼링 방지(있다면)
    }
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)

# ─────────────────────────────────────────────────────────────
# WebSocket (옵션)
# ─────────────────────────────────────────────────────────────
@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket, session_id: str = Query("default")):
    await websocket.accept()
    SESSION.start(session_id)

    seq = 1
    pending = None  # {"seq","t0","t1","text_en"}
    buffer = CaptionBuffer(min_window_sec=10.0, max_window_sec=15.0, min_chars=25)
    timeline_pos = 0.0

    try:
        while True:
            audio_bytes = await websocket.receive_bytes()
            asr = transcribe_chunk(audio_bytes)
            text_en = clean_en((asr["text"] or "").strip())

            if asr["segments"]:
                seg_t0 = asr["segments"][0]["start"]
                seg_t1 = asr["segments"][-1]["end"]
            else:
                seg_t0 = seg_t1 = 0.0

            # 직전 pending을 final로 확정 + 배치 번역 후보로 버퍼링
            if pending and pending["text_en"]:
                await websocket.send_json({
                    "type": "en_final",
                    "seq": pending["seq"],
                    "t0": pending["t0"], "t1": pending["t1"],
                    "text_en": pending["text_en"],
                })
                buffer.add(pending["t0"], pending["t1"], pending["text_en"])
                if buffer.ready():
                    (ft0, ft1), full_en = buffer.flush()
                    text_ko = translate_text(full_en) if full_en else ""
                    SESSION.append(session_id, ft0, ft1, full_en, text_ko)
                    await websocket.send_json({
                        "type": "ko_batch",
                        "window": {"t0": ft0, "t1": ft1},
                        "text_en": full_en,
                        "text_ko": text_ko
                    })
                timeline_pos = pending["t1"]

            g_t0 = timeline_pos + seg_t0
            g_t1 = timeline_pos + seg_t1

            # 이번 청크는 partial
            cur = {"seq": seq, "t0": r2(g_t0), "t1": r2(g_t1), "text_en": text_en}
            await websocket.send_json({
                "type": "en_partial",
                "seq": seq,
                "t0": r2(g_t0), "t1": r2(g_t1),
                "text_en": text_en
            })
            pending = cur
            seq += 1

    except WebSocketDisconnect:
        if pending and pending["text_en"]:
            buffer.add(pending["t0"], pending["t1"], pending["text_en"])
        if getattr(buffer, "en_parts", None):
            (ft0, ft1), full_en = buffer.flush()
            text_ko = translate_text(full_en) if full_en else ""
            SESSION.append(session_id, ft0, ft1, full_en, text_ko)
        SESSION.end(session_id)
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

# ─────────────────────────────────────────────────────────────
# REST: 세션/청크/트랜스크립트/내보내기
# ─────────────────────────────────────────────────────────────
@app.post("/session/start")
def http_session_start():
    sid = str(uuid.uuid4())
    SESSION.start(sid)
    SESSION_TIMELINE[sid] = 0.0
    (DATA_DIR / "sessions" / sid).mkdir(parents=True, exist_ok=True)
    print(f"[DEBUG] Session started: {sid}")
    return {"session_id": sid}

@app.post("/session/stop")
async def http_session_stop(session_id: str = Form(...)):
    print(f"[DEBUG] Session stop requested: {session_id}")
    if session_id not in SESSION_TIMELINE:
        print(f"[DEBUG] Invalid session ID: {session_id}")
        print(f"[DEBUG] Available sessions: {list(SESSION_TIMELINE.keys())}")
        return JSONResponse({"ok": False, "reason": "invalid session_id"}, status_code=400)

    try:
        # 남은 버퍼 플러시
        buf = BUFFERS.pop(session_id, None)
        if buf and getattr(buf, "en_parts", None):
            (ft0, ft1), full_en = buf.flush()
            if full_en:
                text_ko = translate_text(full_en)
                SESSION.append(session_id, ft0, ft1, full_en, text_ko)
                # 세션 종료 직전 마지막 배치도 알림(구독자가 보통 열려있을 수 있음)
                await BROKER.publish(session_id, "ko_batch", {
                    "window": {"t0": r2(ft0), "t1": r2(ft1)},
                    "text_en": full_en,
                    "text_ko": text_ko
                })

        SESSION.end(session_id)
        SESSION_TIMELINE.pop(session_id, None)
        print(f"[DEBUG] Session stopped successfully: {session_id}")
        return JSONResponse({"ok": True})
    except Exception as e:
        print(f"[DEBUG] Session stop error: {e}")
        return JSONResponse({"ok": False, "reason": f"Session stop failed: {str(e)}"}, status_code=500)

def _looks_like_webm_or_ogg(b: bytes) -> bool:
    if not b or len(b) < 16:
        return False
    h = b[:4]
    # EBML(WebM): 1A 45 DF A3
    if h == bytes([0x1A, 0x45, 0xDF, 0xA3]):
        return True
    # Ogg: "OggS"
    if h == b"OggS":
        return True
    if h4 == bytes([0x1F, 0x43, 0xB6, 0x75]):  # Opus in Ogg
        return True
    if b.find(bytes([0x1A, 0x45, 0xDF, 0xA3]), 0, 64) != -1:  # EBML 헤더가 앞에 있는지
        return True
    return False

@app.post("/chunk")
async def http_upload_chunk(session_id: str = Form(...), blob: UploadFile = File(...)):
    print(f"[DEBUG] Chunk upload for session: {session_id}")
    if session_id not in SESSION_TIMELINE:
        print(f"[DEBUG] Invalid session ID in chunk upload: {session_id}")
        print(f"[DEBUG] Available sessions: {list(SESSION_TIMELINE.keys())}")
        return JSONResponse({"ok": False, "reason": "invalid session_id"}, status_code=400)

    # 파일 크기 검증
    if not blob.file or blob.size is None or blob.size < 100:
        print(f"[DEBUG] File too small: {blob.size} bytes")
        return Response(status_code=204)

    # 파일 저장(선택)
    sess_dir = DATA_DIR / "sessions" / session_id / "chunks"
    sess_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    ext = Path(blob.filename).suffix or ".webm"
    save_path = sess_dir / f"chunk_{ts}{ext}"
    with save_path.open("wb") as f:
        shutil.copyfileobj(blob.file, f)

    # 파일 읽기
    with save_path.open("rb") as f:
        audio_bytes = f.read()

    # 파일 크기 재검증
    if len(audio_bytes) < 100:
        print(f"[DEBUG] Skipping small chunk: {len(audio_bytes)} bytes")
        return Response(status_code=204)

    # 업로드된 실제 content-type/확장자 로깅(디버그에 유용)
    uploaded_ct = getattr(blob, "content_type", None) or "unknown"
    ext = (save_path.suffix or "").lower()
    safe_name = save_path.name  # SDK가 filename 확장자로 포맷을 추론

    print(f"[DEBUG] Processing chunk: {len(audio_bytes)} bytes, type: {uploaded_ct}, ext: {ext}")

    # ASR 수행
    try:
        asr = transcribe_chunk(audio_bytes, filename=safe_name)
    except ValueError as e:
        # 포맷/디코딩 실패 등 → 415 (Unsupported Media Type)
        msg = f"ASR error: {str(e)} (ct={uploaded_ct}, ext={ext})"
        print(f"[DEBUG] ASR ValueError: {msg}")
        return JSONResponse({"ok": False, "reason": msg}, status_code=415)
    except Exception as e:
        # 기타 예외 → 400으로 다운그레이드
        msg = f"ASR unexpected error: {type(e).__name__}: {str(e)} (ct={uploaded_ct}, ext={ext})"
        print(f"[DEBUG] ASR Exception: {msg}")
        return JSONResponse({"ok": False, "reason": msg}, status_code=400)

    text_en = clean_en((asr.get("text") or "").strip())
    seg_t0 = asr["segments"][0]["start"] if asr.get("segments") else 0.0
    seg_t1 = asr["segments"][-1]["end"] if asr.get("segments") else 0.0

    print(f"[DEBUG] ASR result: '{text_en}' ({len(text_en)} chars)")

    # 글로벌 타임라인
    last_end = SESSION_TIMELINE.get(session_id, 0.0)
    g_t0 = last_end + seg_t0
    g_t1 = last_end + seg_t1
    SESSION_TIMELINE[session_id] = g_t1

    # (1) en_partial을 즉시 SSE로 전송
    await BROKER.publish(session_id, "en_partial", {"t0": r2(g_t0), "t1": r2(g_t1), "text_en": text_en})

    # (2) 배치 번역을 위한 버퍼링
    buf = BUFFERS.get(session_id)
    if buf is None:
        buf = CaptionBuffer(min_window_sec=10.0, max_window_sec=15.0, min_chars=25)
        BUFFERS[session_id] = buf
    buf.add(g_t0, g_t1, text_en)

    # (3) 준비되면 flush → 번역 → 세션 누적 → SSE ko_batch
    if buf.ready():
        (ft0, ft1), full_en = buf.flush()
        text_ko = translate_text(full_en) if full_en else ""
        SESSION.append(session_id, ft0, ft1, full_en, text_ko)
        await BROKER.publish(session_id, "ko_batch", {
            "window": {"t0": r2(ft0), "t1": r2(ft1)},
            "text_en": full_en,
            "text_ko": text_ko
        })

    return JSONResponse({"ok": True, "saved": save_path.name, "text_en": text_en, "t0": r2(g_t0), "t1": r2(g_t1)})

@app.get("/transcript")
def http_transcript(session_id: str):
    try:
        content = SESSION.to_txt(session_id)
    except Exception:
        content = ""
    return {"transcript": content}

@app.post("/export")
def http_export(session_id: str = Form(...), format: str = "docx"):
    data = SESSION.get(session_id)
    entries = data.get("entries", []) if data else []
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    if format == "txt":
        content = SESSION.to_txt(session_id)
        out = (DATA_DIR / "exports" / f"{session_id}_{ts}.txt")
        out.write_text(content, encoding="utf-8")
        return {"download_url": f"/download/{out.name}"}

    if format == "srt":
        content = SESSION.to_srt(session_id)
        out = (DATA_DIR / "exports" / f"{session_id}_{ts}.srt")
        out.write_text(content, encoding="utf-8")
        return {"download_url": f"/download/{out.name}"}

    # docx
    buf: BytesIO = build_docx(entries)
    out = (DATA_DIR / "exports" / f"{session_id}_{ts}.docx")
    out.write_bytes(buf.getvalue())
    return {"download_url": f"/download/{out.name}"}

@app.get("/download/{filename}")
def http_download(filename: str):
    file_path = DATA_DIR / "exports" / filename
    if not file_path.exists():
        return PlainTextResponse("file not found", status_code=404)
    if file_path.suffix == ".docx":
        mt = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif file_path.suffix == ".srt":
        mt = "application/x-subrip"
    else:
        mt = "text/plain"
    return FileResponse(file_path, filename=file_path.name, media_type=mt)

# ─────────────────────────────────────────────────────────────
# 기존 내보내기 (GET /export/{session_id})
# ─────────────────────────────────────────────────────────────
@app.get("/export/{session_id}")
def export_text(session_id: str, format: str = Query("txt")):
    data = SESSION.get(session_id)
    entries = data.get("entries", [])

    if format == "txt":
        content = SESSION.to_txt(session_id)
        return PlainTextResponse(
            content, headers={"Content-Disposition": f'attachment; filename="{session_id}.txt"'}
        )
    if format == "docx":
        buf = build_docx(entries)
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{session_id}.docx"'}
        )
    if format == "srt":
        content = SESSION.to_srt(session_id)
        return PlainTextResponse(
            content, headers={"Content-Disposition": f'attachment; filename="{session_id}.srt"'}
        )
    return PlainTextResponse("Unsupported format", status_code=400)
