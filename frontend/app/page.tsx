"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, Download, Mic, Square, FileText, RefreshCw } from "lucide-react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

/** GET helper */
async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

/** POST Form helper */
async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  const res = await fetch(url.toString(), { method: "POST", body: form, credentials: "omit" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export default function RecorderApp() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("Idle");
  const [transcript, setTranscript] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // SSR → CSR 수화(hydration) 불일치 방지용
  const [mounted, setMounted] = useState(false);
  const [canRecord, setCanRecord] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastUploadRef = useRef<Promise<any> | null>(null); // 마지막 업로드가 끝날 때까지 stop 지연

  useEffect(() => {
    setMounted(true);
    const supported =
      typeof window !== "undefined" &&
      !!(navigator.mediaDevices && (window as any).MediaRecorder);
    setCanRecord(supported);
  }, []);

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
    return apiPostForm("/chunk", form);
  }, []);

  const handleStart = useCallback(async () => {
    setErrorMsg(null);
    try {
      const sid = await startSession();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 크롬 기준 webm/opus로 고정 (사파리 고려는 추후)
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      mediaRecorderRef.current = mr;

      mr.ondataavailable = async (e: any) => {
        if (!e.data || e.data.size === 0) return;

        // ① 헤더(처음 4바이트) 검사: WebM(EBML) 또는 OGG만 통과
        try {
          const headBuf = await e.data.slice(0, 4).arrayBuffer();
          const h = new Uint8Array(headBuf);
          const isWebM = h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3; // EBML
          const isOgg  = h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53; // "OggS"
          if (!isWebM && !isOgg) {
            console.warn("Skip bad audio chunk (invalid magic header)");
            return;
          }
        } catch {
          console.warn("Skip audio chunk (header read failed)");
          return;
        }

        // ② 업로드 (415는 경고만 남기고 계속 진행)
        const p = uploadChunk(sid, e.data)
          .then(() => setStatusMsg(`Chunk uploaded: ${(e.data.size / 1024).toFixed(1)} KB`))
          .catch((err: any) => {
            const msg = String(err?.message || "");
            if (msg.includes("ASR error:") || msg.includes("415")) {
              console.warn("Non-fatal chunk rejected:", msg);
              setStatusMsg("Skipped a bad chunk");
            } else {
              setErrorMsg(msg || "Upload failed");
            }
          });
        lastUploadRef.current = p;
      };

      mr.onstop = async () => {
        try {
          if (lastUploadRef.current) await lastUploadRef.current; // 마지막 업로드 기다림
        } catch {}
        if (sid) {
          try {
            await stopSession(sid);
          } catch (err: any) {
            setErrorMsg(err?.message || "Stop failed");
          }
        }
        setStatusMsg("Stopped");
      };

      mr.start(5000); // 5초 단위 청크
      setRecording(true);
      setStatusMsg("Recording…");
    } catch (err: any) {
      setErrorMsg(err?.message || "Microphone permission or init error");
      setStatusMsg("Error");
    }
  }, [startSession, uploadChunk, stopSession]);

  const handleStop = useCallback(async () => {
    if (!sessionId) return;
    try {
      mediaRecorderRef.current?.stop();                  // onstop에서 stopSession 처리
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setRecording(false);
    } catch (err: any) {
      setErrorMsg(err?.message || "Stop failed");
    }
  }, [sessionId]);

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

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Card className="shadow-xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-2xl">Lab Meeting Recorder</CardTitle>
              <CardDescription>Start/Stop recording · View current transcript · Export to Word on demand</CardDescription>
            </div>
            <Badge variant={recording ? "default" : "secondary"}>{recording ? "Recording" : "Idle"}</Badge>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-4 pt-4">
          {/* Hydration mismatch 방지: 마운트 후에만 경고 렌더 */}
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

          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">Current transcript</div>
            <Textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              className="min-h-[180px]"
              placeholder="Transcript will appear here."
            />
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <Button onClick={handleExport} disabled={!sessionId}>
              <FileText className="mr-2 h-4 w-4" /> Export current transcript to Word
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

          {errorMsg && <div className="text-sm text-red-600">{errorMsg}</div>}
          <div className="text-xs text-muted-foreground">{statusMsg}</div>
        </CardContent>
        <CardFooter className="text-xs text-muted-foreground">
          Tip: After pressing Export, the download button appears — matching the "only on request" requirement.
        </CardFooter>
      </Card>
    </main>
  );
}
