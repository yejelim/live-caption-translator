# app/main.py
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import PlainTextResponse, StreamingResponse

import os
from app.asr import transcribe_chunk
from app.translate import translate_text
from app.session import SESSION
from app.exporters import build_docx


app = FastAPI(title="Live Caption Translator")

@app.get("/health")
def health():
    return {"ok": True}

@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket, session_id: str = Query("default")):
    await websocket.accept()
    SESSION.start(session_id)
    try:
        while True:
            audio_bytes = await websocket.receive_bytes()
            asr = transcribe_chunk(audio_bytes)  # {"text","segments":[...]}
            text_en = asr["text"]
            text_ko = translate_text(text_en) if text_en else ""
            # 세그먼트 기반 시간 추정(없는 경우 0,0)
            if asr["segments"]:
                t0 = asr["segments"][0]["start"]
                t1 = asr["segments"][-1]["end"]
            else:
                t0 = t1 = 0.0
            # 세션에 누적
            if text_en or text_ko:
                SESSION.append(session_id, t0, t1, text_en, text_ko)
            # 실시간 전송
            await websocket.send_json({
                "type": "final",
                "text_en": text_en,
                "text_ko": text_ko,
                "t0": t0, "t1": t1
            })
    except WebSocketDisconnect:
        SESSION.end(session_id)
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})

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
    # (선택) srt 지원
    elif format == "srt":
        content = SESSION.to_srt(session_id)
        return PlainTextResponse(
            content,
            headers={"Content-Disposition": f'attachment; filename="{session_id}.srt"'}
        )
    else:
        return PlainTextResponse("Unsupported format", status_code=400)
