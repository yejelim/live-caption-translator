# 샘플 wav 파일을 2~3초 단위 조각으로 잘라 WebSocket에 전송해보는 테스트 코드
# 목적: 준비된 WAV 파일을 2~3초 단위 조각으로 잘라 WebSocket으로 전송 (테스트 전용)

import asyncio
import argparse
import wave
from io import BytesIO
import websockets

DEFAULT_WS_URL = "ws://localhost:8080/ws/stream"

def make_wav_chunk_bytes(frames: bytes, rate: int, channels: int, sampwidth: int) -> bytes:
    """주어진 PCM 프레임으로 '헤더 포함' WAV 바이트 생성"""
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()

async def send_wav_in_chunks(path: str, ws_url: str, session_id: str, chunk_sec: float):
    url = f"{ws_url}?session_id={session_id}"
    async with websockets.connect(url, max_size=16 * 1024 * 1024) as ws:
        with wave.open(path, "rb") as w:
            rate = w.getframerate()
            channels = w.getnchannels()
            sampwidth = w.getsampwidth()
            total_frames = w.getnframes()
            frames_per_chunk = int(rate * chunk_sec)

            if channels != 1:
                print(f"[warn] 이 파일은 mono(1채널)가 아닙니다 (channels={channels}). "
                      f"권장 변환: ffmpeg -i {path} -ac 1 -ar 16000 out.wav")

            idx = 0
            sent = 0
            while sent < total_frames:
                to_read = min(frames_per_chunk, total_frames - sent)
                frames = w.readframes(to_read)
                sent += to_read
                idx += 1

                # 각 청크를 '헤더 포함 WAV'로 만들어 전송
                chunk_bytes = make_wav_chunk_bytes(frames, rate, channels, sampwidth)
                await ws.send(chunk_bytes)

                # 서버 응답 수신(영문/한글 자막 JSON)
                msg = await ws.recv()
                print(f"[{idx}] SERVER:", msg)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("wav_path", help="전송할 WAV 파일 경로 (예: sample.wav)")
    ap.add_argument("--ws-url", default=DEFAULT_WS_URL, help="WebSocket 엔드포인트 기본 주소")
    ap.add_argument("--session-id", default="demo-1", help="세션 ID (export 시 사용)")
    ap.add_argument("--chunk-sec", type=float, default=3.0, help="청크 길이(초). 2.0~3.0 권장")
    args = ap.parse_args()

    asyncio.run(send_wav_in_chunks(args.wav_path, args.ws_url, args.session_id, args.chunk_sec))
