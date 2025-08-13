# app/session.py
from typing import Dict, List, Any
from datetime import datetime

class SessionStore:
    def __init__(self):
        self.store: Dict[str, Dict[str, Any]] = {}

    def start(self, sid: str):
        if sid not in self.store:
            self.store[sid] = {
                "created_at": datetime.utcnow().isoformat(),
                "entries": []  # list of {"t0","t1","text_en","text_ko"}
            }

    def append(self, sid: str, t0: float, t1: float, text_en: str, text_ko: str):
        self.start(sid)
        self.store[sid]["entries"].append({
            "t0": t0, "t1": t1,
            "text_en": text_en, "text_ko": text_ko
        })

    def get(self, sid: str) -> Dict[str, Any]:
        return self.store.get(sid, {"entries": []})

    def end(self, sid: str):
        # 필요시 후처리/정렬
        pass

    def to_txt(self, sid: str) -> str:
        data = self.get(sid)
        lines = []
        for i, e in enumerate(data["entries"], 1):
            lines.append(f"[{i}] ({e['t0']:.2f}–{e['t1']:.2f}s)")
            lines.append(f"EN: {e['text_en']}")
            if e["text_ko"]:
                lines.append(f"KO: {e['text_ko']}")
            lines.append("")
        return "\n".join(lines).strip()

    def to_srt(self, sid: str) -> str:
        # 선택 기능: 자막 파일 필요 시 사용
        def fmt(t):
            # 12.34 -> 00:00:12,340
            h = int(t // 3600); m = int((t % 3600) // 60); s = int(t % 60); ms = int((t - int(t)) * 1000)
            return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
        data = self.get(sid)
        lines = []
        for i, e in enumerate(data["entries"], 1):
            lines.append(str(i))
            lines.append(f"{fmt(e['t0'])} --> {fmt(e['t1'])}")
            lines.append(e["text_en"])
            if e["text_ko"]:
                lines.append(e["text_ko"])
            lines.append("")
        return "\n".join(lines).strip()

SESSION = SessionStore()
