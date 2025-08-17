# 1) .env는 가장 먼저 로드
from dotenv import load_dotenv
load_dotenv()

import os
import re
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import PlainTextResponse, StreamingResponse, HTMLResponse

from app.asr import transcribe_chunk
from app.translate import translate_text
from app.session import SESSION
from app.exporters import build_docx

def clean_en(s: str) -> str:
    if not s:
        return s
    s = re.sub(r"\s+", " ", s).strip() # 공백 정리
    s = re.sub(r"\.{3,}$", ".", s) # 말미의 ... → .
    # 너무 짧지 않고 끝에 문장부호 없으면 마침표 보정 
    if len(s) > 40 and not re.search(r"[.!?]$", s):
            s += "."
    return s


# 전송 직전 시간 표시 반올림 
def r2(x: float) -> float:
    return float(f"{x:.2f}")

app = FastAPI(title="Live Caption Translator")

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
        <li>WebSocket: <code>ws://localhost:8080/ws/stream?session_id=demo</code></li>
        <li>Export: <code>/export/&lt;session_id&gt;?format=txt|docx|srt</code></li>
      </ul>
    </body>
    </html>
    """

# ─────────────────────────────────────────────────────────────
# 최소–최대 윈도우 버퍼 (EN 누적 → KO 배치 번역용)
# ─────────────────────────────────────────────────────────────
class CaptionBuffer:
    def __init__(self, min_window_sec: float = 8.0, max_window_sec: float = 12.0, min_chars: int = 20):
        assert max_window_sec >= min_window_sec, "max_window_sec must be >= min_window_sec"
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
# WebSocket: EN(실시간 partial→final) + KO(10초 배치)
# ─────────────────────────────────────────────────────────────
@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket, session_id: str = Query("default")):
    await websocket.accept()
    SESSION.start(session_id)

    seq = 1
    pending = None  # {"seq","t0","t1","text_en"}
    buffer = CaptionBuffer(min_window_sec=10.0, max_window_sec=15.0, min_chars=25)
    prev_en_block = None  # (V2 대비: 바로 이전 KO 블록 EN)
    timeline_pos = 0.0 # 청크들의 글로벌 시작 시간 명시 (초)

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



            # ➊ 직전 pending을 final로 확정 + KO 버퍼 누적/번역
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
                        "text_en": full_en,   # 필요 없으면 삭제 가능
                        "text_ko": text_ko
                    })
                    prev_en_block = full_en  # (V2 대비)
                
                # 직전 청크 길이만큼 글로벌 타임라인을 전진
                timeline_pos = pending["t1"]

            # 직전 청크의 글로벌 끝으로 타임라인 전진
            if pending:
                timeline_pos = pending["t1"]

            # 청크를 받아서 로컬 -> 글로벌 타임라인으로 맵핑
            g_t0 = timeline_pos + seg_t0
            g_t1 = timeline_pos + seg_t1

            # ➋ 현재 청크는 즉시 partial로 표시
            cur = {"seq": seq, "t0": g_t0, "t1": g_t1, "text_en": text_en, "local_t0": seg_t0, "local_t1": seg_t1}
            await websocket.send_json({
                "type": "en_partial",
                "seq": seq,
                "t0": seg_t0, "t1": seg_t1,
                "t0": r2(g_t0), "t1": r2(g_t1),  # 글로벌 타임라인 위치
                "text_en": text_en
            })
            pending = cur
            seq += 1

    except WebSocketDisconnect:
        # 마지막 pending을 final 처리 + KO 버퍼 반영
        if pending and pending["text_en"]:
            await websocket.send_json({
                "type": "en_final",
                "seq": pending["seq"],
                "t0": pending["t0"], "t1": pending["t1"],
                "text_en": pending["text_en"],
            })
            buffer.add(pending["t0"], pending["t1"], pending["text_en"])

        # 남은 KO 버퍼 flush
        if buffer.en_parts:
            (ft0, ft1), full_en = buffer.flush()
            text_ko = translate_text(full_en) if full_en else ""
            SESSION.append(session_id, ft0, ft1, full_en, text_ko)
            await websocket.send_json({
                "type": "ko_batch",
                "window": {"t0": r2(ft0), "t1": r2(ft1)},
                # "text_en": full_en,
                "text_ko": text_ko
            })
        SESSION.end(session_id)
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})

# ─────────────────────────────────────────────────────────────
# 내보내기 (TXT / DOCX / SRT)
# ─────────────────────────────────────────────────────────────
@app.get("/export/{session_id}")
def export_text(session_id: str, format: str = Query("txt")):
    data = SESSION.get(session_id)
    entries = data.get("entries", [])

    if format == "txt":
        content = SESSION.to_txt(session_id)
        return PlainTextResponse(
            content,
            headers={"Content-Disposition": f'attachment; filename="{session_id}.txt"'}
        )
    elif format == "docx":
        buf = build_docx(entries)
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{session_id}.docx"'}
        )
    elif format == "srt":
        content = SESSION.to_srt(session_id)
        return PlainTextResponse(
            content,
            headers={"Content-Disposition": f'attachment; filename="{session_id}.srt"'}
        )
    else:
        return PlainTextResponse("Unsupported format", status_code=400)
