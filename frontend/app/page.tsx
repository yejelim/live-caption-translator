"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, Download, Mic, Square, FileText, RefreshCw } from "lucide-react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

/** ---------- HTTP helpers ---------- */
async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  
  try {
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      const errorText = await res.text();
      try {
        const errorJson = JSON.parse(errorText);
        throw new Error(errorJson.reason || errorJson.message || `HTTP ${res.status}`);
      } catch {
        throw new Error(errorText || `HTTP ${res.status}`);
      }
    }
    
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return res.json() as Promise<T>;
    } else {
      throw new Error('Expected JSON response but got: ' + contentType);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('Network error: Failed to connect to server');
    }
    throw error;
  }
}

async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  
  try {
    const res = await fetch(url.toString(), { 
      method: "POST", 
      body: form, 
      credentials: "omit" 
    });
    
    if (!res.ok) {
      const errorText = await res.text();
      try {
        const errorJson = JSON.parse(errorText);
        throw new Error(errorJson.reason || errorJson.message || `HTTP ${res.status}`);
      } catch {
        throw new Error(errorText || `HTTP ${res.status}`);
      }
    }
    
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return res.json() as Promise<T>;
    } else {
      throw new Error('Expected JSON response but got: ' + contentType);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('Network error: Failed to connect to server');
    }
    throw error;
  }
}

/** ---------- Types ---------- */
type ConfirmedLine = { t0: number; t1: number; en: string; ko: string };

/** ---------- MediaRecorder utils ---------- */
function pickSupportedMime(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus", // Chrome 계열
    "audio/webm",
    "audio/ogg;codecs=opus",  // Firefox/일부 Linux
    "audio/mp4",              // Safari(웹킷)
  ];
  const MR: any = (typeof window !== "undefined" ? (window as any).MediaRecorder : undefined);
  for (const t of candidates) {
    if (MR?.isTypeSupported?.(t)) return t;
  }
  return undefined; // 브라우저 기본값 사용
}

export default function RecorderApp() {
  /** ---------- UI state ---------- */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("Idle");
  const [transcript, setTranscript] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  /** ---------- Live captions via SSE ---------- */
  const sseRef = useRef<EventSource | null>(null);
  const [liveLine, setLiveLine] = useState<string>("");           // 진행 중 영어(임시)
  const [lines, setLines] = useState<ConfirmedLine[]>([]);        // 확정된 배치

  /** ---------- MediaRecorder refs ---------- */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastUploadRef = useRef<Promise<any> | null>(null);
  const sliceTimerRef = useRef<number | null>(null);              // requestData 타이머

  /** ---------- SSR→CSR 안전 ---------- */
  const [mounted, setMounted] = useState(false);
  const [canRecord, setCanRecord] = useState(false);

  useEffect(() => {
    setMounted(true);
    const supported =
      typeof window !== "undefined" &&
      !!(navigator.mediaDevices && (window as any).MediaRecorder);
    setCanRecord(supported);

    return () => {
      // 컴포넌트 언마운트 시 정리
      try { sseRef.current?.close(); } catch {}
      if (sliceTimerRef.current) {
        window.clearInterval(sliceTimerRef.current);
        sliceTimerRef.current = null;
      }
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    };
  }, []);

  /** ---------- API wrappers ---------- */
  const startSession = useCallback(async () => {
    const res = await fetch(new URL("/session/start", API_BASE_URL).toString(), { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    setSessionId(data.session_id);
    return data.session_id as string;
  }, []);

  const stopSession = useCallback(async (sid: string) => {
    const form = new FormData();
    form.append("session_id", sid);
    await apiPostForm("/session/stop", form);
  }, []);

  const uploadChunk = useCallback(async (sid: string, blob: Blob) => {
    const form = new FormData();
    form.append("session_id", sid);
    form.append("blob", blob, `part_${Date.now()}.webm`);
    
    try {
      const res = await fetch(new URL("/chunk", API_BASE_URL).toString(), { 
        method: "POST", 
        body: form, 
        credentials: "omit" 
      });
      
      // 204는 정상적인 응답 (스킵된 청크)
      if (res.status === 204) {
        return { ok: true, reason: "skipped" };
      }
      
      if (!res.ok) {
        const errorText = await res.text();
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.reason || errorJson.message || `HTTP ${res.status}`);
        } catch {
          throw new Error(errorText || `HTTP ${res.status}`);
        }
      }
      
      // Content-Type이 없는 경우도 처리
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return res.json();
      } else if (res.status === 200) {
        // 200 응답이지만 JSON이 아닌 경우
        return { ok: true };
      } else {
        throw new Error('Unexpected response format');
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Error('Network error: Failed to connect to server');
      }
      throw error;
    }
  }, []);

  /** ---------- SSE open/close ---------- */
  const openSSE = useCallback((sid: string) => {
    const url = new URL("/events", API_BASE_URL);
    url.searchParams.set("session_id", sid);
    
    // 기존 연결이 있으면 닫기
    if (sseRef.current) {
      try { sseRef.current.close(); } catch {}
    }
    
    const ev = new EventSource(url.toString());
    
    // 연결 성공
    ev.onopen = () => {
      console.log("[SSE] Connected");
      setStatusMsg("SSE connected");
    };

    ev.addEventListener("en_partial", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setLiveLine(String(data?.text_en || ""));
      } catch (err) {
        console.warn("[SSE] Failed to parse en_partial:", e.data, err);
      }
    });

    ev.addEventListener("ko_batch", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const t0 = Number(data?.window?.t0 ?? 0);
        const t1 = Number(data?.window?.t1 ?? 0);
        const en = String(data?.text_en ?? "");
        const ko = String(data?.text_ko ?? "");
        setLines((prev) => [...prev, { t0, t1, en, ko }]);
        setTranscript((prev) => (prev ? prev + "\n" : "") + ko);
        setLiveLine(""); // 확정 시 임시 라인 정리
      } catch (err) {
        console.warn("[SSE] Failed to parse ko_batch:", e.data, err);
      }
    });

    ev.onerror = (event) => {
      console.error("[SSE] Error:", event);
      setStatusMsg("SSE connection error");
      try { ev.close(); } catch {}
      sseRef.current = null;
    };



    sseRef.current = ev;
  }, []);

  const closeSSE = useCallback(() => {
    try { sseRef.current?.close(); } catch {}
    sseRef.current = null;
  }, []);

  /** ---------- Start Recording ---------- */
  const handleStart = useCallback(async () => {
    setErrorMsg(null);
    setDownloadUrl(null);
    setTranscript("");
    setLiveLine("");
    setLines([]);
    try {
      const sid = await startSession();
      console.log("[DEBUG] Session started:", sid);

      // SSE 먼저 오픈 → UI 즉시 갱신 가능
      openSSE(sid);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickSupportedMime();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;

      // ---- MR event logs (디버깅에 유용) ----
      mr.onstart  = () => console.log("[MR] start", { mimeType: mr.mimeType, state: mr.state });
      mr.onpause  = () => console.log("[MR] pause");
      mr.onresume = () => console.log("[MR] resume");
      mr.onerror  = (e: any) => { console.error("[MR] error", e); setErrorMsg(`Recorder error: ${e?.error || e}`); };

      // ---- 오디오 트랙이 중간에 끊기는 이슈 감시 ----
      const track = stream.getAudioTracks()[0];
      track.onended = () => {
        console.warn("[MR] audio track ended unexpectedly");
        setStatusMsg("Audio track ended (device/permission)");
      };

      // ---- 데이터 수신 → 업로드 ----
      mr.ondataavailable = async (e: BlobEvent) => {
        if (!e.data || e.data.size === 0) return;

        // 세션이 종료된 경우 업로드하지 않음
        if (!sessionId) {
          console.warn("[DEBUG] Session already ended, skipping chunk upload");
          return;
        }

        // 헤더가 애매해도 업로드 시도(백엔드 ffmpeg fallback 신뢰)
        try {
          const headBuf = await e.data.slice(0, 4).arrayBuffer();
          const h = new Uint8Array(headBuf);
          const isWebM = h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3;
          const isOgg  = h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53;
          if (!isWebM && !isOgg) {
            console.warn("Header looks odd; sending anyway (ffmpeg fallback).");
          }
        } catch {
          console.warn("Header read failed; sending anyway.");
        }

        console.log("[MR] blob", e.data.type, (e.data.size / 1024).toFixed(1), "KB");

        const p = uploadChunk(sessionId, e.data)
          .then((result) => {
            if (result.reason === "skipped") {
              setStatusMsg(`Chunk skipped (${(e.data.size / 1024).toFixed(1)} KB)`);
            } else {
              setStatusMsg(`Chunk uploaded: ${(e.data.size / 1024).toFixed(1)} KB`);
            }
          })
          .catch((err: any) => {
            const msg = String(err?.message || "");
            console.warn("Chunk upload error:", msg);
            if (msg.includes("ASR error:") || msg.includes("415") || msg.includes("skipped")) {
              console.warn("Non-fatal chunk rejected:", msg);
              setStatusMsg("Skipped a bad chunk");
            } else {
              setErrorMsg(msg || "Upload failed");
            }
          });
        lastUploadRef.current = p;
      };

      // ---- timeslice + requestData로 강제 분할 ----
      const SLICE_MS = 3000; // 3초 단위로 줄임 (더 안정적)
      try {
        mr.start(SLICE_MS); // 일부 브라우저는 이 값 무시 가능 → 아래 타이머로 보강
      } catch {
        mr.start(); // timeslice 미지원 환경
      }
      // requestData 강제 호출 타이머 (브라우저 timeslice 무시 대비)
      sliceTimerRef.current = window.setInterval(() => {
        if (mr.state === "recording") {
          try { 
            console.log("[DEBUG] Forcing data request");
            mr.requestData(); 
          } catch (e) {
            console.warn("[DEBUG] requestData failed:", e);
          }
        }
      }, SLICE_MS);

      // ---- stop 시 정리 ----
      mr.onstop = async () => {
        console.log("[MR] stop");
        if (sliceTimerRef.current) {
          window.clearInterval(sliceTimerRef.current);
          sliceTimerRef.current = null;
        }
        try {
          if (lastUploadRef.current) await lastUploadRef.current;
        } catch {}
        if (sid) {
          try {
            console.log("[DEBUG] Stopping session:", sid);
            await stopSession(sid); // 백엔드에서 마지막 버퍼 flush + ko_batch 푸시
          } catch (err: any) {
            console.error("[DEBUG] Session stop error:", err);
            setErrorMsg(err?.message || "Stop failed");
          }
        }
        setStatusMsg("Stopped");
      };

      setRecording(true);
      setStatusMsg(`Recording… (${mr.mimeType || "default"})`);
    } catch (err: any) {
      setErrorMsg(err?.message || "Microphone permission or init error");
      setStatusMsg("Error");
    }
  }, [startSession, openSSE, stopSession, uploadChunk, sessionId]);

  /** ---------- Stop Recording ---------- */
  const handleStop = useCallback(async () => {
    if (!sessionId) {
      console.warn("[DEBUG] No session ID available for stop");
      return;
    }
    try {
      console.log("[DEBUG] Stopping recording, session ID:", sessionId);
      
      // 정리 순서: MR → 타이머 → 스트림 → SSE
      mediaRecorderRef.current?.stop();
      if (sliceTimerRef.current) {
        window.clearInterval(sliceTimerRef.current);
        sliceTimerRef.current = null;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      closeSSE();

      setRecording(false);
      setSessionId(null); // 세션 ID 초기화로 후속 청크 업로드 방지
    } catch (err: any) {
      console.error("[DEBUG] Stop recording error:", err);
      setErrorMsg(err?.message || "Stop failed");
    }
  }, [sessionId, closeSSE]);

  /** ---------- Manual fetch/export ---------- */
  const fetchTranscript = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await apiGet<{ transcript: string }>("/transcript", { session_id: sessionId });
      setTranscript(data.transcript || "");
      setStatusMsg("Transcript refreshed");
    } catch (err: any) {
      setErrorMsg(err?.message || "Fetch transcript failed");
    }
  }, [sessionId]);

  const handleExport = useCallback(async () => {
    if (!sessionId) return;
    try {
      const form = new FormData();
      form.append("session_id", sessionId);
      const data = await apiPostForm<{ download_url: string }>("/export", form);
      const absolute = new URL(data.download_url, API_BASE_URL).toString();
      setDownloadUrl(absolute);
      setStatusMsg("Export ready — download available");
    } catch (err: any) {
      setErrorMsg(err?.message || "Export failed");
    }
  }, [sessionId]);

  /** ---------- UI ---------- */
  return (
    <main className="mx-auto max-w-3xl p-6">
      <Card className="shadow-xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-2xl">Lab Meeting Recorder</CardTitle>
              <CardDescription>Start/Stop · Live captions · Export transcript</CardDescription>
            </div>
            <Badge variant={recording ? "default" : "secondary"}>{recording ? "Recording" : "Idle"}</Badge>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-4 pt-4">
          {mounted && !canRecord && (
            <div className="flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle className="h-4 w-4" />
              <span>Your browser does not support MediaRecorder or mic permissions are blocked.</span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleStart} disabled={recording || !canRecord}>
              <Mic className="mr-2 h-4 w-4" /> Start Recording
            </Button>
            <Button variant="secondary" onClick={handleStop} disabled={!recording}>
              <Square className="mr-2 h-4 w-4" /> Stop Recording
            </Button>
            <Button variant="outline" onClick={fetchTranscript} disabled={!sessionId}>
              <RefreshCw className="mr-2 h-4 w-4" /> Fetch Transcript
            </Button>
          </div>

          {/* Live captions (임시 영어) */}
          {liveLine && (
            <div className="p-3 rounded-md bg-muted/40 text-sm">
              <div className="text-muted-foreground mb-1">Live (partial)</div>
              <div className="font-medium">{liveLine}</div>
            </div>
          )}

          {/* 최근 확정된 배치 3줄 미리보기 */}
          {lines.length > 0 && (
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground mt-2">Recent confirmed captions</div>
              {lines.slice(-3).map((ln, i) => (
                <div key={`${ln.t0}-${i}`} className="text-sm">
                  <span className="mr-2 text-muted-foreground">[{ln.t0.toFixed(1)}–{ln.t1.toFixed(1)}]</span>
                  <span className="font-medium">{ln.ko}</span>
                </div>
              ))}
            </div>
          )}

          {/* 누적 스크립트 (Korean) */}
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">Current transcript (accumulated)</div>
            <Textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              className="min-h-[180px]"
              placeholder="Transcript will appear here."
            />
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <Button onClick={handleExport} disabled={!sessionId}>
              <FileText className="mr-2 h-4 w-4" /> Export to Word
            </Button>
            {downloadUrl && (
              <a
                href={downloadUrl}
                download
                className="inline-flex items-center px-4 py-2 rounded-md bg-black text-white text-sm font-medium"
              >
                <Download className="mr-2 h-4 w-4" /> Download Word file
              </a>
            )}
          </div>

          {errorMsg && (
            <div className="p-3 rounded-md bg-red-50 border border-red-200">
              <div className="flex items-center gap-2 text-red-700">
                <AlertCircle className="h-4 w-4" />
                <span className="font-medium">Error:</span>
                <span className="text-sm">{errorMsg}</span>
              </div>
            </div>
          )}
          <div className="text-xs text-muted-foreground">{statusMsg}</div>
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          Tip: 일부 브라우저는 timeslice를 무시합니다. 이 코드는 requestData 타이머로 강제 분할합니다.
        </CardFooter>
      </Card>
    </main>
  );
}