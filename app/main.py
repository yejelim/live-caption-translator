# FastAPI 서버 + WebSocket

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
import os
from app.asr import transcribe_chunk
from app.translate import translate_text

load_dotenv()
app = FastAPI(title="Live Caption Translator")

@app.get("/health")
def health():
    return {"ok": True}

@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # 클라이언트에서 바이너리(wav 조각) 수신
            audio_bytes = await websocket.receive_bytes()
            # 영어 자막
            text_en = transcribe_chunk(audio_bytes)
            # 한국어 번역
            text_ko = translate_text(text_en) if text_en else ""
            # 전송 
            await websocket.send_json({
                "type": "final",
                "text_en": text_en,
                "text_ko": text_ko  
            })
    except WebSocketDisconnect:
        pass
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})