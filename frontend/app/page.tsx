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
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    } else {
      throw new Error("Expected JSON response but got: " + contentType);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error("Network error: Failed to connect to server");
    }
    throw error;
  }
}

async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  try {
    const res = await fetch(url.toString(), { method: "POST", body: form, credentials: "omit" });
    if (!res.ok) {
      const errorText = await res.text();
      try {
        const errorJson = JSON.parse(errorText);
        throw new Error(errorJson.reason || errorJson.message || `HTTP ${res.status}`);
      } catch {
        throw new Error(errorText || `HTTP ${res.status}`);
      }
    }
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    } else if (res.status === 200) {
      return { ok: true } as unknown as T;
    } else {
      throw new Error("Unexpected response format");
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error("Network error: Failed to connect to server");
    }
    throw error;
  }
}

/** ---------- Types ---------- */
type ConfirmedLine = { t0: number; t1: number; en: string; ko: string };

/** ---------- MediaRecorder utils ---------- */
// OGG 우선 (여러 환경에서 각 청크가 독립 파일로 더 안정적으로 생성됨)
function pickSupportedMime(): string | undefined {
  const MR: any = typeof window !== "undefined" ? (window as any).MediaRecorder : undefined;
  const candidates = [
    "audio/ogg;codecs=opus",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (MR?.isTypeSupported?.(t)) return t;
  }
  return undefined;
}

function guessExtFromType(type: string): string {
  if (!type) return ".wav";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("webm")) return ".webm";
  if (type.includes("mp4")) return ".mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("wav")) return ".wav";
  if (type.includes("m4a")) return ".m4a";
  if (type.includes("flac")) return ".flac";
  return ".wav";
}

const LIVE_MIN_CHARS = 80;
const LIVE_MAX_AGE_MS = 2500;

export default function RecorderApp() {
  /** ---------- UI state ---------- */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("Idle");
  const [transcript, setTranscript] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("Idle");
  const [sessionActive, setSessionActive] = useState(false); // (옵션) 사용 유지
  const [canResume, setCanResume] = useState(false);

  /** ---------- Live captions via SSE ---------- */
  const sseRef = useRef<EventSource | null>(null);
  const [liveLine, setLiveLine] = useState<string>("");
  const [lines, setLines] = useState<ConfirmedLine[]>([]);

  const liveBufRef = useRef<string[]>([]);
  const liveLastUpdateRef = useRef<number>(0);
  const liveFlushTimerRef = useRef<number | null>(null);

  /** ---------- Media / flow refs ---------- */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastUploadRef = useRef<Promise<any> | null>(null);

  // 업로드/세그먼트 제어
  const allowUploadsRef = useRef<boolean>(false);
  const segmentingRef = useRef<boolean>(false);

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
      try { sseRef.current?.close(); } catch {}
      try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
      allowUploadsRef.current = false;
      segmentingRef.current = false;
      // ❗ 세션은 언마운트 시에도 유지할지/정리할지 선택 사항
      // 여기서 sessionIdRef를 null로 지우면 복구 불가이므로 유지
    };
  }, []);

  /** ---------- API wrappers ---------- */
  const startSession = useCallback(async () => {
    const res = await fetch(new URL("/session/start", API_BASE_URL).toString(), { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    setSessionId(data.session_id);
    sessionIdRef.current = data.session_id;
    return data.session_id as string;
  }, []);

  const stopSession = useCallback(async (sid: string) => {
    const form = new FormData();
    form.append("session_id", sid);
    await apiPostForm("/session/stop", form);
  }, []);

  const pauseSession = useCallback(async (sid: string) => {
    const form = new FormData();
    form.append("session_id", sid);
    await apiPostForm("/session/pause", form);
  }, []);

  const uploadChunk = useCallback(async (sid: string, blob: Blob) => {
    const form = new FormData();
    const ext = guessExtFromType(blob.type);
    form.append("session_id", sid);
    form.append("blob", blob, `part_${Date.now()}${ext}`);
    try {
      const res = await fetch(new URL("/chunk", API_BASE_URL).toString(), {
        method: "POST",
        body: form,
        credentials: "omit",
      });
      if (res.status === 204) return { ok: true, reason: "skipped" };
      if (!res.ok) {
        const errorText = await res.text();
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.reason || errorJson.message || `HTTP ${res.status}`);
        } catch {
          throw new Error(errorText || `HTTP ${res.status}`);
        }
      }
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return res.json();
      } else if (res.status === 200) {
        return { ok: true };
      } else {
        throw new Error("Unexpected response format");
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw new Error("Network error: Failed to connect to server");
      }
      throw error;
    }
  }, []);

  /** ---------- SSE open/close ---------- */
  const openSSE = useCallback((sid: string) => {
    const url = new URL("/events", API_BASE_URL);
    url.searchParams.set("session_id", sid);
    if (sseRef.current) {
      try { sseRef.current.close(); } catch {}
    }
    const ev = new EventSource(url.toString());
    ev.onopen = () => {
      console.log("[SSE] Connected");
      setStatusMsg("SSE connected");
    };
    
    // openSSE 안의 en_partial 이벤트 리스너 교체

    ev.addEventListener("en_partial", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const snippet = String(data?.text_en || "").trim();
        if (!snippet) return;

        // 1) 버퍼에 누적
        liveBufRef.current.push(snippet);

        // 2) 디바운스/조건부 플러시
        const now = Date.now();
        const joined = liveBufRef.current.join(" ").replace(/\s+/g, " ").trim();

        const shouldFlushByLen = joined.length >= LIVE_MIN_CHARS;
        const shouldFlushByTime = now - (liveLastUpdateRef.current || 0) >= LIVE_MAX_AGE_MS;

        const doFlush = () => {
          const out = liveBufRef.current.join(" ").replace(/\s+/g, " ").trim();
          if (out) {
            setLiveLine(out);
            liveLastUpdateRef.current = Date.now();
          }
          liveBufRef.current = [];
          liveFlushTimerRef.current = null;
        };

        if (shouldFlushByLen || shouldFlushByTime) {
          // 즉시 갱신
          if (liveFlushTimerRef.current) {
            window.clearTimeout(liveFlushTimerRef.current);
            liveFlushTimerRef.current = null;
          }
          doFlush();
        } else {
          // 약간의 지연 후 갱신(사용자 체감 안정화)
          if (!liveFlushTimerRef.current) {
            liveFlushTimerRef.current = window.setTimeout(() => {
              doFlush();
            }, 600); // 0.6초 디바운스
          }
        }
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
        setTranscript((prev) => (prev ? prev + "\n" : "") + en);
        setLiveLine("");
        liveBufRef.current = [];
        if (liveFlushTimerRef.current) {
          window.clearTimeout(liveFlushTimerRef.current);
          liveFlushTimerRef.current = null;
        }
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

  /** ---------- Segmented recorder loop ---------- */
  const SLICE_MS = 3000;

  const startRecorderSegment = useCallback((sid: string, stream: MediaStream) => {
    const mimeType = pickSupportedMime();
    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = mr;

    mr.onstart = () => {
      console.log("[MR] start", { mimeType: mr.mimeType, state: mr.state });
    };

    mr.ondataavailable = async (e: BlobEvent) => {
      if (!allowUploadsRef.current || !segmentingRef.current) return;
      if (!e.data || e.data.size === 0) return;

      const p = uploadChunk(sid, new Blob([e.data], { type: e.data.type }))
        .then((result) => {
          if ((result as any)?.reason === "skipped") {
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

    mr.onstop = async () => {
      console.log("[MR] stop");
      // 세그먼트 루프: stop 직후 다음 세그먼트 시작
      if (segmentingRef.current) {
        setTimeout(() => {
          startRecorderSegment(sid, stream);
        }, 10);
      }
    };

    // 세그먼트 길이만큼 녹음 후 stop해서 완전 파일(헤더 포함)로 고정
    mr.start(); // timeslice 미사용
    setTimeout(() => {
      try { mr.stop(); } catch {}
    }, SLICE_MS);
  }, [uploadChunk, setStatusMsg, setErrorMsg]);

  /** ---------- Start / Pause / Resume / Complete ---------- */
  const handleStart = useCallback(async () => {
    setErrorMsg(null);
    setDownloadUrl(null);
    setTranscript("");
    setLiveLine("");
    setLines([]);
    setCanResume(false); // 새 세션 시작이므로

    allowUploadsRef.current = true;
    segmentingRef.current = true;

    try {
      const sid = await startSession();
      console.log("[DEBUG] Session started:", sid);
      openSSE(sid);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 세그먼트 녹음 시작
      startRecorderSegment(sid, stream);

      setRecording(true);
      setStatusMsg("Recording… (segmented)");
      setSessionActive(true);
      setSessionStatus("Recording");
    } catch (err: any) {
      allowUploadsRef.current = false;
      segmentingRef.current = false;
      setErrorMsg(err?.message || "Microphone permission or init error");
      setStatusMsg("Error");
    }
  }, [startSession, openSSE, startRecorderSegment]);

  const handlePause = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      console.warn("[DEBUG] No session ID available for pause");
      return;
    }

    // 업로드/세그먼트 즉시 차단 (녹음만 멈춘다)
    allowUploadsRef.current = false;
    segmentingRef.current = false;

    try {
      console.log("[DEBUG] Pausing recording, session ID:", sid);

      try { mediaRecorderRef.current?.stop(); } catch {}
      try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
      closeSSE();

      try { if (lastUploadRef.current) await lastUploadRef.current; } catch {}

      // 세션은 종료하지 않는다
      await pauseSession(sid);

      // 세션 ID는 유지 → 재개 가능
      setRecording(false);
      setCanResume(true);
      setStatusMsg("Paused — resume to continue appending to the same session");
      setSessionStatus("Paused");
    } catch (err: any) {
      console.error("[DEBUG] Pause error:", err);
      setErrorMsg(err?.message || "Pause failed");
    }
  }, [closeSSE, pauseSession]);

  const handleResume = useCallback(async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;

    try {
      // 기존 내용 유지: transcript/lines/liveline 초기화 금지
      openSSE(sid);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      allowUploadsRef.current = true;
      segmentingRef.current = true;
      startRecorderSegment(sid, stream);

      setRecording(true);
      setCanResume(false);
      setStatusMsg("Recording resumed (same session)");
      setSessionStatus("Recording");
    } catch (err: any) {
      setErrorMsg(err?.message || "Resume failed");
      setStatusMsg("Error");
    }
  }, [openSSE, startRecorderSegment, sessionId]);

  const handleCompleteSession = useCallback(async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;

    // 업로드/세그먼트 차단 및 장치/채널 정리
    allowUploadsRef.current = false;
    segmentingRef.current = false;
    try { mediaRecorderRef.current?.stop(); } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    closeSSE();

    try {
      if (lastUploadRef.current) await lastUploadRef.current;
    } catch {}

    try {
      await stopSession(sid);  // 백엔드에 세션 종료 요청
      setStatusMsg("Session completed");
      setSessionActive(false);
      setRecording(false);
      setCanResume(false);
      setSessionStatus("Idle");
      // 종료해도 UI 텍스트는 보존 (다운로드/리뷰 가능)
      // sessionIdRef/ sessionId는 선택적으로 null 처리 가능
      // 여기선 다운로드 후에도 계속 같은 텍스트 표시를 원해 유지
    } catch (err: any) {
      setErrorMsg(err?.message || "Session completion failed");
    }
  }, [sessionId, stopSession, closeSSE]);

  /** ---------- Manual fetch/export ---------- */
  const fetchTranscript = useCallback(async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    try {
      const data = await apiGet<{ transcript: string }>("/transcript", { session_id: sid });
      setTranscript(data.transcript || "");
      setStatusMsg("Transcript refreshed");
    } catch (err: any) {
      setErrorMsg(err?.message || "Fetch transcript failed");
    }
  }, [sessionId]);

  const handleExport = useCallback(async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    try {
      const form = new FormData();
      form.append("session_id", sid);
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
              <CardDescription>Start/Resume · Live captions · Export transcript</CardDescription>
            </div>
            <Badge variant={recording ? "default" : canResume ? "outline" : "secondary"}>
              {recording ? "Recording" : canResume ? "Paused" : "Idle"}
            </Badge>
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
            {/* 새 세션 시작 (기존 내용 초기화) */}
            <Button onClick={handleStart} disabled={recording || !canRecord}>
              <Mic className="mr-2 h-4 w-4" /> Start New Session
            </Button>

            {/* 일시정지 (세션 유지) */}
            <Button variant="secondary" onClick={handlePause} disabled={!recording}>
              <Square className="mr-2 h-4 w-4" /> Pause
            </Button>

            {/* 재개 (동일 세션) */}
            <Button variant="outline" onClick={handleResume} disabled={!canResume || recording || !sessionIdRef.current}>
              <Mic className="mr-2 h-4 w-4" /> Resume
            </Button>

            <Button variant="outline" onClick={fetchTranscript} disabled={!sessionIdRef.current && !sessionId}>
              <RefreshCw className="mr-2 h-4 w-4" /> 한국어 번역 보기
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
                  <span className="font-medium">{ln.en}</span>
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
            <Button onClick={handleExport} disabled={!sessionIdRef.current && !sessionId || recording}>
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

        <CardFooter className="flex flex-col gap-2 text-xs text-muted-foreground">
          <div>Made with ❤️ by yeze at HealCode</div>
          {/* 선택 버튼: 세션 완전 종료 (정리/아카이브 용도) */}
          <div className="w-full flex items-center justify-end">
            <Button variant="ghost" className="text-xs" onClick={handleCompleteSession} disabled={!sessionIdRef.current && !sessionId}>
              세션 완전 종료
            </Button>
          </div>
        </CardFooter>
      </Card>
    </main>
  );
}
