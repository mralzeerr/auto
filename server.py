# خادم مساعد BYD ليبرد 8 — يقدم ملفات التطبيق + بحث يوتيوب + نطق إماراتي طبيعي
import asyncio
import http.server
import json
import os
import re
import socketserver
import urllib.parse
import urllib.request

try:
    import edge_tts  # أصوات مايكروسوفت العصبية (حمدان/فاطمة الإماراتية)
except ImportError:
    edge_tts = None

# محليًا: منفذ 8017 على الجهاز فقط — في السحابة (Render): المنفذ من متغير البيئة PORT
PORT = int(os.environ.get("PORT", 8017))
HOST = "0.0.0.0" if "PORT" in os.environ else "127.0.0.1"
os.chdir(os.path.dirname(os.path.abspath(__file__)))

ALLOWED_VOICES = {"ar-AE-HamdanNeural", "ar-AE-FatimaNeural"}
_tts_cache = {}  # (voice, text) -> mp3 bytes — يسرّع الجمل المتكررة


async def _synth(text, voice):
    buf = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            buf.extend(chunk["data"])
    return bytes(buf)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # منع المتصفح من تخزين نسخ قديمة من ملفات التطبيق
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/yt?"):
            self.handle_yt()
            return
        if self.path.startswith("/tts?"):
            self.handle_tts()
            return
        super().do_GET()

    def handle_tts(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        text = qs.get("text", [""])[0].strip()
        voice = qs.get("voice", ["ar-AE-HamdanNeural"])[0]
        if voice not in ALLOWED_VOICES:
            voice = "ar-AE-HamdanNeural"
        if not text or edge_tts is None:
            self.send_response(501)
            self.end_headers()
            return
        key = (voice, text)
        audio = _tts_cache.get(key)
        if audio is None:
            try:
                audio = asyncio.run(_synth(text, voice))
            except Exception:
                audio = b""
            if audio:
                if len(_tts_cache) >= 200:
                    _tts_cache.clear()
                _tts_cache[key] = audio
        if not audio:
            self.send_response(502)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def handle_yt(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        query = qs.get("q", [""])[0].strip()
        live = qs.get("live", ["0"])[0] == "1"
        dur = qs.get("dur", [""])[0]
        ids = []
        error = None
        try:
            url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote(query)
            # فلاتر يوتيوب: بث مباشر للأخبار، أو مقاطع طويلة (+20 دقيقة) للأفلام
            if live:
                url += "&sp=" + urllib.parse.quote("EgJAAQ==")
            elif dur == "long":
                url += "&sp=" + urllib.parse.quote("EgIYAg==")
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                "Accept-Language": "ar,en;q=0.8",
            })
            html = urllib.request.urlopen(req, timeout=12).read().decode("utf-8", "ignore")
            for m in re.finditer(r'"videoId":"([\w-]{11})"', html):
                vid = m.group(1)
                if vid not in ids:
                    ids.append(vid)
                if len(ids) >= 15:
                    break
        except Exception as e:
            error = str(e)

        body = json.dumps({"ids": ids, "error": error}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # بدون ضجيج في الطرفية


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"مساعد ليبرد 8 شغال على: http://localhost:{PORT}")
    ThreadingServer((HOST, PORT), Handler).serve_forever()
