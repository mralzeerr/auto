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

# إذاعات إماراتية حقيقية — روابط بث مجرّبة (تحقق منها 2026-07-24)
CURATED_STATIONS = [
    {"name": "إمارات FM", "url": "https://admn-radio-cdn-lb.starzplayarabia.com/out/v1/admn_radio_enc/emarat_fm/emarat_fm_hls_nd/index.m3u8"},
    {"name": "القرآن الكريم — الشارقة", "url": "https://l3.itworkscdn.net/smcquranlive/quranradiolive/icecast.audio"},
    {"name": "أبوظبي FM", "url": "https://admn-radio-cdn-lb.starzplayarabia.com/out/v1/admn_radio_enc/abudhabi_fm/abudhabi_fm_hls_nd/index.m3u8"},
    {"name": "إذاعة الشارقة", "url": "https://svs.itworkscdn.net/sharjahradiolive/sharjahradio/playlist.m3u8"},
    {"name": "أبوظبي كلاسيك FM", "url": "https://admn-radio-cdn-lb.starzplayarabia.com/out/v1/admn_radio_enc/classic_fm/classic_fm_hls_nd/index.m3u8"},
    {"name": "ستار FM", "url": "https://admn-radio-cdn-lb.starzplayarabia.com/out/v1/admn_radio_enc/star_fm/star_fm_hls_nd/index.m3u8"},
    {"name": "Pulse 95 — الشارقة (إنجليزي)", "url": "https://svs.itworkscdn.net/pulselive/pulseradio/playlist.m3u8"},
    {"name": "TAG 91.1 (هندي)", "url": "https://cast4.servcast.net/proxy/v81radioworldwide/live"},
    {"name": "City 1016 (هندي)", "url": "https://n07.radiojar.com/gmwyu8xdrxquv"},
]
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

    def do_POST(self):
        if self.path == "/ai":
            self.handle_ai()
            return
        self.send_response(404)
        self.end_headers()

    def handle_ai(self):
        # ذكاء اصطناعي مجاني عندما لا يضع المستخدم مفتاح Claude:
        # 1) Gemini بمفتاح خدمة واحد للتطبيق كله (FREE_AI_KEY في بيئة الاستضافة — مجاني بدون بطاقة)
        # 2) احتياط بدون أي مفتاح (Pollinations) — يقبل النصوص القصيرة فقط
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            payload = {}
        system = payload.get("system") or ""
        messages = payload.get("messages") or []
        text = None
        error = None

        gem_key = os.environ.get("FREE_AI_KEY", "").strip()
        if gem_key:
            try:
                body = json.dumps({
                    "model": os.environ.get("FREE_AI_MODEL", "gemini-2.0-flash"),
                    "messages": [{"role": "system", "content": system}] + messages,
                }).encode("utf-8")
                req = urllib.request.Request(
                    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                    data=body,
                    headers={"Content-Type": "application/json",
                             "Authorization": "Bearer " + gem_key},
                )
                data = json.loads(urllib.request.urlopen(req, timeout=45).read().decode("utf-8", "ignore"))
                text = data["choices"][0]["message"]["content"]
            except Exception as e:
                error = "gemini: " + str(e)

        if text is None:
            try:
                body = json.dumps({
                    "model": "openai",
                    "referrer": "byd-car-assistant",
                    "messages": [{"role": "system", "content": system[:400]}] + messages[-4:],
                }).encode("utf-8")
                req = urllib.request.Request(
                    "https://text.pollinations.ai/openai",
                    data=body,
                    headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
                )
                data = json.loads(urllib.request.urlopen(req, timeout=45).read().decode("utf-8", "ignore"))
                text = data["choices"][0]["message"]["content"]
            except Exception as e:
                error = (error + " | " if error else "") + "free: " + str(e)

        body = json.dumps({"text": text, "error": None if text else error}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/yt?"):
            self.handle_yt()
            return
        if self.path.startswith("/tts?"):
            self.handle_tts()
            return
        if self.path.startswith("/radio"):
            self.handle_radio()
            return
        super().do_GET()

    def handle_radio(self):
        # بدون q: القائمة الإماراتية المضمونة — مع q: بحث بالاسم (المضمونة أولًا ثم Radio Browser عالميًا)
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        q = qs.get("q", [""])[0].strip()
        stations = []
        error = None

        if not q:
            stations = list(CURATED_STATIONS)
        else:
            ql = q.lower()
            stations = [s for s in CURATED_STATIONS if ql in s["name"].lower()]
            for host in ("de1.api.radio-browser.info", "fi1.api.radio-browser.info", "at1.api.radio-browser.info"):
                try:
                    params = {"name": q, "hidebroken": "true", "order": "votes", "reverse": "true", "limit": "25"}
                    url = "https://" + host + "/json/stations/search?" + urllib.parse.urlencode(params)
                    req = urllib.request.Request(url, headers={"User-Agent": "BYD-Car-Assistant/1.0"})
                    data = json.loads(urllib.request.urlopen(req, timeout=10).read().decode("utf-8", "ignore"))
                    seen = {s["name"].lower() for s in stations}
                    for s in data:
                        surl = (s.get("url_resolved") or s.get("url") or "").strip()
                        name = (s.get("name") or "").strip()
                        # التطبيق https — بث http يمنعه المتصفح (HLS مدعوم عبر hls.js في الواجهة)
                        if not surl.startswith("https://"):
                            continue
                        key = name.lower()
                        if not name or key in seen or "exclusiv" in key:
                            continue
                        seen.add(key)
                        stations.append({"name": name, "url": surl})
                        if len(stations) >= 20:
                            break
                    break
                except Exception as e:
                    error = str(e)

        body = json.dumps({"stations": stations[:20], "error": None if stations else error}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
