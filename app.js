/* ============================================================
   مساعد BYD ليبرد 8 — مساعد قيادة ذكي بالأوامر الصوتية
   ملاحة + طقس + ازدحام + موسيقى + محاكاة قيادة ذاتية + Claude AI
   ============================================================ */

"use strict";

// ---------- الحالة العامة ----------
const state = {
  pos: { lat: 25.2048, lng: 55.2708 },   // الافتراضي: دبي حتى يصل GPS
  gpsOk: false,
  dest: null,          // { lat, lng, name }
  route: null,         // بيانات OSRM
  routeCoords: [],     // [ [lat,lng], ... ]
  routeLine: null,
  carMarker: null,
  destMarker: null,
  driving: false,
  simAnim: null,
  listening: false,
  awaitingConfirm: null,   // دالة تُستدعى عند نعم/لا صوتيًا
  chatHistory: [],         // محادثة Claude
  weatherCache: null,
  settings: {
    apiKey: localStorage.getItem("byd_api_key") || "",
    autoListen: localStorage.getItem("byd_auto_listen") === "1",
    tts: localStorage.getItem("byd_tts") !== "0",
    voice: localStorage.getItem("byd_voice") || "ar-AE-HamdanNeural",
    carModel: localStorage.getItem("byd_model") || "8",
  },
};

// ---------- موديلات السيارة ----------
const CAR_MODELS = {
  "5": {
    name: "ليبرد 5", speech: "ليبرد خمسة",
    info: `🚙 BYD ليبرد 5 (Leopard 5 / Bao 5)
• دفع رباعي هجين DMO — قوة ~677 حصان
• تسارع 0-100: حوالي 4.8 ثانية
• مدى كهربائي يصل ~125 كم ومدى إجمالي ~1200 كم
• نظام تعليق DiSus-P الذكي
وحش الطرق الوعرة ما شاء الله! 🐆`,
    infoSpeech: "سيارتك بي واي دي ليبرد خمسة، دفع رباعي هجين بقوة تقارب ستمئة وسبعين حصان، ومدى إجمالي يوصل ألف ومئتين كيلومتر. وحش الطرق الوعرة ما شاء الله",
  },
  "7": {
    name: "ليبرد 7", speech: "ليبرد سبعة",
    info: `🚙 BYD ليبرد 7 (Leopard 7)
• دفع رباعي هجين بقوة تتجاوز 600 حصان
• تسارع 0-100: حوالي 4.5 ثانية
• مدى إجمالي يتجاوز 1000 كم
• تعليق DiSus الذكي ونظام مساعدة القيادة "عين الإله" (God's Eye)
سيارة فخمة ما شاء الله! 🐆`,
    infoSpeech: "سيارتك بي واي دي ليبرد سبعة، دفع رباعي هجين بقوة فوق ستمئة حصان، ومدى إجمالي فوق ألف كيلومتر. سيارة فخمة ما شاء الله",
  },
  "8": {
    name: "ليبرد 8", speech: "ليبرد ثمانية",
    info: `🚙 BYD ليبرد 8 (Leopard 8 / Bao 8)
• دفع رباعي هجين DMO — قوة تتجاوز 750 حصان
• تسارع 0-100: حوالي 4.8 ثانية
• مدى كهربائي يصل ~100 كم ومدى إجمالي +1000 كم
• نظام تعليق DiSus-P الذكي
• نظام مساعدة القيادة "عين الإله" (God's Eye)
سيارة فخمة ما شاء الله! 🐆`,
    infoSpeech: "سيارتك بي واي دي ليبرد ثمانية، دفع رباعي هجين بقوة فوق سبعمئة وخمسين حصان، ومدى إجمالي فوق ألف كيلومتر. سيارة فخمة ما شاء الله",
  },
};

function carModel() { return CAR_MODELS[state.settings.carModel] || CAR_MODELS["8"]; }

function applyCarModel() {
  const label = document.getElementById("carModelLabel");
  if (label) label.textContent = carModel().name;
  document.title = "BYD " + carModel().name;
}

// ---------- عناصر الواجهة ----------
const $ = (id) => document.getElementById(id);
const ui = {
  clock: $("clock"), weatherChip: $("weatherChip"),
  tripPanel: $("tripPanel"), tripDest: $("tripDest"),
  tripDistance: $("tripDistance"), tripDuration: $("tripDuration"), tripEta: $("tripEta"),
  simRow: $("simRow"), simSpeed: $("simSpeed"), simRemaining: $("simRemaining"),
  startDriveBtn: $("startDriveBtn"), stopDriveBtn: $("stopDriveBtn"),
  cancelRouteBtn: $("cancelRouteBtn"),
  chatLog: $("chatLog"),
  musicPanel: $("musicPanel"), musicTitle: $("musicTitle"), mediaIcon: $("mediaIcon"),
  musicFrameWrap: $("musicFrameWrap"), closeMusicBtn: $("closeMusicBtn"),
  fullscreenBtn: $("fullscreenBtn"),
  micBtn: $("micBtn"), textInput: $("textInput"), sendBtn: $("sendBtn"),
  confirmModal: $("confirmModal"), confirmTitle: $("confirmTitle"),
  confirmText: $("confirmText"), confirmYes: $("confirmYes"), confirmNo: $("confirmNo"),
  settingsModal: $("settingsModal"), settingsBtn: $("settingsBtn"),
  apiKeyInput: $("apiKeyInput"), autoListenChk: $("autoListenChk"), ttsChk: $("ttsChk"),
  voiceSel: $("voiceSel"), carModelSel: $("carModelSel"),
  settingsSave: $("settingsSave"), settingsClose: $("settingsClose"),
};

// ---------- الساعة ----------
function tickClock() {
  const d = new Date();
  ui.clock.textContent = d.toLocaleTimeString("ar-AE", { hour: "2-digit", minute: "2-digit" });
}
setInterval(tickClock, 5000); tickClock();

// ---------- الخريطة ----------
const map = L.map("map", { zoomControl: false, attributionControl: true })
  .setView([state.pos.lat, state.pos.lng], 13);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap &copy; CARTO",
}).addTo(map);

L.control.zoom({ position: "bottomleft" }).addTo(map);

const carIcon = L.divIcon({ className: "car-marker", html: "🚙", iconSize: [30, 30], iconAnchor: [15, 15] });
const destIcon = L.divIcon({ className: "dest-marker", html: "📍", iconSize: [30, 30], iconAnchor: [15, 28] });

state.carMarker = L.marker([state.pos.lat, state.pos.lng], { icon: carIcon }).addTo(map);

// GPS
if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (p) => {
      state.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (!state.gpsOk) {
        state.gpsOk = true;
        map.setView([state.pos.lat, state.pos.lng], 15);
        fetchWeather();
      }
      if (!state.driving) state.carMarker.setLatLng([state.pos.lat, state.pos.lng]);
    },
    () => { addMsg("sys", "⚠️ ما قدرت أحدد موقعك — شغال على موقع افتراضي (دبي). فعّل صلاحية الموقع للمتصفح."); fetchWeather(); },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
} else { fetchWeather(); }

// ---------- سجل المحادثة ----------
function addMsg(kind, text) {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  div.textContent = text;
  ui.chatLog.appendChild(div);
  while (ui.chatLog.children.length > 8) ui.chatLog.removeChild(ui.chatLog.firstChild);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}

// ---------- النطق ----------
let arVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  arVoice = vs.find(v => v.lang && v.lang.toLowerCase().startsWith("ar")) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// الصوت الأساسي: إماراتي طبيعي (حمدان/فاطمة) من السيرفر /tts — وصوت المتصفح احتياط فقط
const ttsAudio = new Audio();
let ttsSeq = 0;

function stopSpeaking() {
  ttsSeq++;
  try { ttsAudio.pause(); ttsAudio.removeAttribute("src"); } catch (_) {}
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function speakFallback(text, cb) {
  if (!("speechSynthesis" in window)) { if (cb) cb(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ar-AE";
  if (arVoice) u.voice = arVoice;
  u.rate = 1.0;
  u.onend = () => { if (cb) cb(); };
  u.onerror = () => { if (cb) cb(); };
  speechSynthesis.speak(u);
}

function speak(text, cb) {
  if (!state.settings.tts) { if (cb) cb(); return; }
  stopSpeaking();
  const seq = ttsSeq;
  fetch("/tts?voice=" + encodeURIComponent(state.settings.voice) + "&text=" + encodeURIComponent(text))
    .then(r => { if (!r.ok) throw new Error("tts " + r.status); return r.blob(); })
    .then(blob => {
      if (seq !== ttsSeq) return;
      const src = URL.createObjectURL(blob);
      ttsAudio.src = src;
      ttsAudio.onended = () => { URL.revokeObjectURL(src); if (seq === ttsSeq && cb) cb(); };
      ttsAudio.onerror = () => { URL.revokeObjectURL(src); if (seq === ttsSeq) speakFallback(text, cb); };
      return ttsAudio.play();
    })
    .catch(() => { if (seq === ttsSeq) speakFallback(text, cb); });
}

function reply(text, opts = {}) {
  addMsg("bot", text);
  speak(opts.speech !== undefined ? opts.speech : text, () => {
    if (state.settings.autoListen && !state.awaitingConfirm) startListening();
  });
}

// ---------- التعرف على الصوت ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SR) {
  recognition = new SR();
  recognition.lang = "ar-AE";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  recognition.onresult = (e) => {
    const text = e.results[e.results.length - 1][0].transcript.trim();
    if (text) handleInput(text);
  };
  recognition.onend = () => {
    state.listening = false;
    ui.micBtn.classList.remove("listening");
  };
  recognition.onerror = (e) => {
    state.listening = false;
    ui.micBtn.classList.remove("listening");
    if (e.error === "not-allowed") addMsg("sys", "⚠️ يجب السماح باستخدام الميكروفون من المتصفح.");
  };
}

function startListening() {
  if (!recognition) { addMsg("sys", "⚠️ المتصفح لا يدعم التعرف على الصوت — استخدم Chrome أو Edge."); return; }
  if (state.listening) return;
  stopSpeaking();
  try { recognition.start(); state.listening = true; ui.micBtn.classList.add("listening"); } catch (_) {}
}
function stopListening() {
  if (recognition && state.listening) recognition.stop();
}

ui.micBtn.addEventListener("click", () => state.listening ? stopListening() : startListening());

// ---------- الإدخال ----------
ui.sendBtn.addEventListener("click", () => {
  const t = ui.textInput.value.trim();
  if (t) { ui.textInput.value = ""; handleInput(t); }
});
ui.textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") ui.sendBtn.click(); });
document.querySelectorAll(".qb").forEach(b => b.addEventListener("click", () => handleInput(b.dataset.cmd)));

// ---------- مُعالج الأوامر الرئيسي ----------
async function handleInput(text) {
  addMsg("user", text);

  // إذا ننتظر تأكيدًا صوتيًا
  if (state.awaitingConfirm) {
    const yes = /^(هيه|هيّه|اي|أي|ايه|أيه|ايوه|أيوه|نعم|أجل|اجل|موافق|أوافق|اوافق|يلا|يلّا|يالله|ابدأ|ابدا|زين|طيب|اوكي|أوكي|اوكيه|تمام|ok|yes)/i.test(text);
    const no = /^(لا|لأ|إلغاء|الغاء|كلا|خلاص|توقف|no|cancel)/i.test(text);
    if (yes || no) {
      const fn = state.awaitingConfirm;
      state.awaitingConfirm = null;
      hideConfirm();
      fn(yes);
      return;
    }
  }

  const t = normalize(text);

  // ---- أوامر الملاحة ----
  const navMatch = t.match(/(?:وصلني|وصّلني|خذني|وديني|ودني|اذهب|روح|سير|انتقل|توجه|ابا اروح|أبا أروح|ابا اسير|بغيت اروح|بغيت اسير|ابي اروح|ابغى اروح|طريق)\s*(?:إلى|الى|ل|لي|عند)?\s+(.+)/) ||
                   t.match(/^(?:إلى|الى)\s+(.+)/);
  if (navMatch) return doNavigate(navMatch[1]);

  // ---- القيادة الذاتية ----
  if (/(انطلق|قود|ابدأ القيادة|ابدا القيادة|شغل القيادة|سوق|انطلاق)/.test(t)) return requestDrive();
  if (/^(توقف|قف|أوقف|اوقف|ايقاف|إيقاف)( القيادة| السيارة)?$/.test(t)) return stopDrive(true);

  // ---- إلغاء المسار ----
  if (/(الغ|ألغ|احذف|امسح).*(المسار|الوجهة|الطريق|الرحلة)/.test(t)) return cancelRoute(true);

  // ---- الطقس ----
  if (/(الطقس|الجو|حرار|درجة|أمطار|امطار|مطر|رياح)/.test(t)) return doWeather();

  // ---- الازدحام ----
  if (/(ازدحام|زحمة|زحمه|مرور|مزدحم|traffic)/.test(t)) return doTraffic();

  // ---- ملء الشاشة / تصغير نافذة العرض ----
  if (/(ملء الشاشة|ملي الشاشة|املأ الشاشة|املا الشاشة|كبر (الشاشة|العرض|الفيديو|الفلم|الفيلم|النافذة))/.test(t)) {
    if (ui.musicPanel.classList.contains("hidden")) return reply("ما في شي معروض حالياً عشان أكبره.");
    mediaFullscreen(true);
    return reply("⛶ كبرت لك العرض على كامل الشاشة — قول «صغر العرض» أو اضغط ⛶ عشان أرجعه.", { speech: "تم، كبرته لك" });
  }
  if (/(صغر (الشاشة|العرض|الفيديو|الفلم|الفيلم|النافذة)|رجع (الشاشة|العرض|النافذة))/.test(t)) {
    mediaFullscreen(false);
    return reply("تم، رجعت العرض للحجم العادي.");
  }

  // ---- التواصل الاجتماعي ----
  if (/(واتساب|الواتساب|واتس|تيليجرام|التيليجرام|تلغرام|تلجرام|تيك توك|تكتوك|تويتر|سناب|التواصل|السوشل|السوشيال)/.test(t) && /(وقف|أوقف|اوقف|سكر|اقفل|اغلق|أغلق)/.test(t)) return stopMusic();
  if (/(واتساب|الواتساب|واتس اب|الواتس|وتساب)/.test(t)) return openSocial("whatsapp");
  if (/(تيليجرام|التيليجرام|تلغرام|التلغرام|تلجرام|التلجرام|تيلجرام)/.test(t)) return openSocial("telegram");
  if (/(تيك توك|التيك توك|تكتوك|التكتوك)/.test(t)) return openSocial("tiktok");
  if (/(تويتر|التويتر|منصة اكس|منصة إكس|^اكس$|^إكس$|افتح اكس|افتح إكس|شغل اكس|شغل إكس)/.test(t)) return openSocial("x");
  if (/(سناب شات|السناب|سناب)/.test(t)) return openSocial("snapchat");
  if (/(التواصل|مركز التواصل|السوشل|السوشيال|وسائل التواصل)/.test(t)) return doSocialHub();

  // ---- الراديو والإذاعات ----
  if (/(راديو|الراديو|إذاعة|اذاعة|الإذاعة|الاذاعة|إذاعات|اذاعات|الإذاعات|الاذاعات|محطة|المحطة|محطات)/.test(t)) {
    if (/(وقف|أوقف|اوقف|سكر|اقفل)/.test(t)) return stopMusic();
    if (/(غير|بدل|الثانية|التالية|اللي بعدها|عقب)/.test(t) && mediaMode === "radio" && radioStations.length) {
      radioTryCount = 0;
      playRadioStation(radioIdx + 1);
      return;
    }
    const rm = t.match(/(?:راديو|الراديو|إذاعة|اذاعة|الإذاعة|الاذاعة|محطة|المحطة)\s*(.*)/);
    const rq = rm && rm[1] ? rm[1].trim() : "";
    if (/(شغل|شغّل|افتح|حط|ابا اسمع|أبا أسمع|ابي اسمع|ابغى اسمع|بغيت اسمع|سمعني|اسمعني)/.test(t) || !rq) return doRadio(rq);
  }

  // ---- الكاميرات ----
  if (/(كاميرا|الكاميرات|كامرة|كامره)/.test(t)) {
    if (/(وقف|أوقف|اوقف|سكر|اقفل|اغلق|أغلق)/.test(t)) return stopMusic();
    if (/(360|٣٦٠|ثلاثمية وستين|ثلاث مية وستين|محيطي|شامل)/.test(t)) return doCamera("360");
    if (/(أمامية|امامية|الأمامية|الامامية|الأمام|الامام|جدام|قدام)/.test(t)) return doCamera("front");
    if (/(خلفية|الخلفية|خلف|الخلف|ورا|وراء)/.test(t)) return doCamera("rear");
    if (/(شغل|شغّل|افتح|ورني|وريني|عرض|اعرض|شوف|شيك)/.test(t)) return doCamera("rear");
  }

  // ---- الأفلام والفيديو والأخبار ----
  const wv = "(?:شغل|شغّل|عرض|اعرض|ورني|وريني|افتح|حط|ابا اشوف|أبا أشوف|ابي اشوف|ابغى اشوف|بغيت اشوف)";
  const movieMatch = t.match(new RegExp(wv + "\\s*(?:لي\\s+)?(?:فلم|فيلم|الفلم|الفيلم|افلام|أفلام)\\s*(.*)"));
  if (movieMatch) {
    const name = movieMatch[1].trim();
    return doVideo(name ? "فيلم " + name + " كامل" : "أفلام كاملة", { long: true });
  }
  if (new RegExp(wv + "\\s*(?:لي\\s+)?(?:ال)?[اأ]خبار").test(t) || /[اأ]خبار.*(مباشر|حي|لايف)/.test(t)) {
    const nm = t.match(/[اأ]خبار\s*(.*)/);
    return doVideo("أخبار بث مباشر" + (nm && nm[1] ? " " + nm[1].trim() : ""), { live: true });
  }
  const videoMatch = t.match(new RegExp(wv + "\\s*(?:لي\\s+)?(?:فيديوهات|فيديو|مقاطع|مقطع)\\s*(.*)"));
  if (videoMatch) {
    const vq = videoMatch[1].trim();
    return doVideo(vq || "مقاطع منوعة");
  }

  // ---- الموسيقى ----
  const musicMatch = t.match(/(?:شغل|شغّل|اسمعني|سمعني|ابا اسمع|أبا أسمع|بغيت اسمع|ابي اسمع|ابغى اسمع)\s+(?:لي\s+)?(?:أغنية|اغنية|أغاني|اغاني|موسيقى|نشيد|قرآن|قران|سورة|سوره)?\s*(.*)/);
  if (musicMatch && /(شغل|شغّل|اسمعني|سمعني|ابا اسمع|أبا أسمع|بغيت اسمع|ابي اسمع|ابغى اسمع)/.test(t)) {
    const q = musicMatch[1].trim();
    return doMusic(q || "موسيقى هادئة");
  }
  if (/(وقف|أوقف|اوقف|اقفل|سكر).*(الأغنية|الاغنية|الموسيقى|الصوت|الأغاني|الاغاني|الفيديو|الفلم|الفيلم|الأخبار|الاخبار|العرض|المقطع)/.test(t)) return stopMusic();

  // ---- الموقع ----
  if (/(أين أنا|اين انا|وين انا|وين أنا|ويني|موقعي|مكاني)/.test(t)) return doWhereAmI();

  // ---- معلومات السيارة ----
  if (/(معلومات|مواصفات).*(السيارة|سيارتي|ليبرد|ليوبارد)/.test(t) || /^سيارتي$/.test(t)) return doCarInfo();

  // ---- الوقت ----
  if (/(كم الساعة|الوقت|التاريخ)/.test(t)) {
    const d = new Date();
    return reply(`الساعة الحين ${d.toLocaleTimeString("ar-AE", {hour:"2-digit", minute:"2-digit"})} — ${d.toLocaleDateString("ar-AE", {weekday:"long", day:"numeric", month:"long", year:"numeric"})}`);
  }

  // ---- تكبير/تصغير الخريطة ----
  if (/(كبر|قرب).*(الخريطة|الخارطة)/.test(t)) { map.zoomIn(2); return reply("كبرتها لك."); }
  if (/(صغر|بعد|ابعد).*(الخريطة|الخارطة)/.test(t)) { map.zoomOut(2); return reply("صغرتها لك."); }

  // ---- وضع الراحة (أمر مميز) ----
  if (/(وضع الراحة|وضع الاسترخاء|استرخاء)/.test(t)) {
    reply("فعلت لك وضع الراحة. بشغل لك موسيقى هادية، ارتاح وخلك مستانس 🌙", { speech: "فعلت لك وضع الراحة، ارتاح وخلك مستانس" });
    return doMusic("موسيقى استرخاء هادئة", true);
  }

  // ---- وضع الرحلة (أمر مميز) ----
  if (/(وضع الرحلة|وضع السفر)/.test(t)) {
    await doWeather();
    if (state.route) await doTraffic();
    return reply("وضع الرحلة جاهز! قول لي وين تبا تروح وبرسم لك الطريج 🗺️");
  }

  // ---- التحية ----
  if (/^(مرحبا|مرحبًا|هلا|أهلا|اهلا|السلام عليكم|صباح الخير|مساء الخير|شحالك|شخبارك|هاي)/.test(t)) {
    return reply(`هلا والله! شحالك؟ آنا مساعد سيارتك ${carModel().name}. قول لي: «وصلني…»، «شحال الجو؟»، «شغل أغنية…»، أو اسألني اللي تباه 🚙`);
  }

  // ---- غير ذلك → Claude AI ----
  return askClaude(text);
}

function normalize(s) {
  return s.replace(/[؟?!.،,]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------- الملاحة ----------
async function doNavigate(query) {
  reply(`🔍 أدور لك على «${query}»…`, { speech: "لحظة، أدور لك عليه" });
  try {
    const vb = [state.pos.lng - 2, state.pos.lat - 2, state.pos.lng + 2, state.pos.lat + 2].join(",");
    let res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ar&viewbox=${vb}&bounded=0&q=${encodeURIComponent(query)}`);
    let list = await res.json();
    if (!list.length) {
      res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ar&q=${encodeURIComponent(query)}`);
      list = await res.json();
    }
    if (!list.length) return reply(`ما حصلت «${query}» — جرّب اسم أوضح أو زيد اسم المدينة.`);

    const place = list[0];
    const dest = { lat: parseFloat(place.lat), lng: parseFloat(place.lon), name: place.display_name.split(",").slice(0, 2).join("،") };
    await routeTo(dest);
  } catch (err) {
    reply("⚠️ ما قدرت أوصل لخدمة البحث. تأكد من النت.");
  }
}

async function routeTo(dest) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${state.pos.lng},${state.pos.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes.length) return reply("ما قدرت أحسب طريج لهالوجهة.");

    const route = data.routes[0];
    state.dest = dest;
    state.route = route;
    state.routeCoords = route.geometry.coordinates.map(c => [c[1], c[0]]);

    if (state.routeLine) map.removeLayer(state.routeLine);
    if (state.destMarker) map.removeLayer(state.destMarker);
    state.routeLine = L.polyline(state.routeCoords, { color: "#00c8ff", weight: 6, opacity: 0.85 }).addTo(map);
    state.destMarker = L.marker([dest.lat, dest.lng], { icon: destIcon }).addTo(map);
    map.fitBounds(state.routeLine.getBounds(), { padding: [60, 60] });

    const km = (route.distance / 1000).toFixed(1);
    const mins = Math.round(route.duration / 60);
    const eta = new Date(Date.now() + route.duration * 1000);

    ui.tripDest.textContent = "📍 " + dest.name;
    ui.tripDistance.textContent = km + " كم";
    ui.tripDuration.textContent = fmtMins(mins);
    ui.tripEta.textContent = eta.toLocaleTimeString("ar-AE", { hour: "2-digit", minute: "2-digit" });
    ui.tripPanel.classList.remove("hidden");
    ui.startDriveBtn.classList.remove("hidden");
    ui.simRow.classList.add("hidden");

    reply(`تم! رسمت لك الطريج إلى ${dest.name}.\n📏 المسافة: ${km} كم — ⏱️ الوقت: ${fmtMins(mins)} — 🕐 بتوصل الساعة: ${ui.tripEta.textContent}.\nتبا أبدأ القيادة الذاتية (محاكاة)؟`,
      { speech: `تم، رسمت لك الطريج. المسافة ${km} كيلومتر، والوقت المتوقع ${fmtMins(mins)}. تبا أبدأ القيادة الذاتية؟` });

    state.awaitingConfirm = (yes) => { if (yes) startDrive(); else reply("زين، الطريج جاهز متى ما تبا تنطلق."); };
    if (state.settings.autoListen || state.listening) {} else startListening();
  } catch (err) {
    reply("⚠️ ما قدرت أحسب الطريج. تأكد من النت.");
  }
}

function fmtMins(mins) {
  if (mins < 60) return mins + " دقيقة";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h + " س " + (m ? m + " د" : "");
}

function cancelRoute(announce) {
  if (state.routeLine) { map.removeLayer(state.routeLine); state.routeLine = null; }
  if (state.destMarker) { map.removeLayer(state.destMarker); state.destMarker = null; }
  stopDrive(false);
  state.dest = null; state.route = null; state.routeCoords = [];
  ui.tripPanel.classList.add("hidden");
  if (announce) reply("تم، لغيت الطريج.");
}
ui.cancelRouteBtn.addEventListener("click", () => cancelRoute(true));

// ---------- القيادة الذاتية (محاكاة) ----------
function requestDrive() {
  if (!state.route) return reply("حدد وجهتك أول — قول مثلًا: «وصلني المطار».");
  if (state.driving) return reply("القيادة الذاتية شغالة من قبل 🚗");
  showConfirm(
    "🚗 تأكيد القيادة الذاتية",
    `توافق نبدأ القيادة الذاتية إلى:\n${state.dest.name}؟\n\n(هذي محاكاة على الخريطة — التطبيق ما يتحكم بالسيارة الحقيقية)`,
    (yes) => { if (yes) startDrive(); else reply("تم، لغيتها. الطريج باقي معروض."); }
  );
  speak("توافق نبدأ القيادة الذاتية للوجهة؟ قول هيه أو لا", () => startListening());
}

function startDrive() {
  if (!state.routeCoords.length) return;
  state.driving = true;
  ui.startDriveBtn.classList.add("hidden");
  ui.simRow.classList.remove("hidden");
  reply("✅ تم — بديت القيادة الذاتية (محاكاة). طريج السلامة! 🛣️", { speech: "تم، بدينا القيادة الذاتية. طريج السلامة" });

  // مسافات تراكمية على المسار
  const pts = state.routeCoords;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];

  // خطوات المناورة للتنبيه الصوتي
  const steps = [];
  try {
    let acc = 0;
    for (const leg of state.route.legs) {
      for (const s of leg.steps) {
        if (s.maneuver && s.name) steps.push({ at: acc, text: arManeuver(s) });
        acc += s.distance;
      }
    }
  } catch (_) {}
  let nextStep = 1; // نتجاوز خطوة البداية

  const SPEED_KMH = 70;                 // سرعة المحاكاة المعروضة
  const TIME_SCALE = 25;                // تسريع الزمن حتى لا تطول المحاكاة
  const mps = (SPEED_KMH / 3.6) * TIME_SCALE;

  let dist = 0;
  let last = performance.now();

  function frame(now) {
    if (!state.driving) return;
    dist += mps * ((now - last) / 1000);
    last = now;

    if (dist >= total) {
      state.carMarker.setLatLng(pts[pts.length - 1]);
      finishDrive();
      return;
    }
    // موضع السيارة على المسار
    let i = 1;
    while (i < cum.length && cum[i] < dist) i++;
    const segLen = cum[i] - cum[i - 1] || 1;
    const f = (dist - cum[i - 1]) / segLen;
    const lat = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f;
    const lng = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
    state.carMarker.setLatLng([lat, lng]);
    map.panTo([lat, lng], { animate: false });

    // تحديث اللوحة
    const remainKm = ((total - dist) / 1000);
    ui.simSpeed.textContent = SPEED_KMH;
    ui.simRemaining.textContent = remainKm.toFixed(1) + " كم";
    const remainSec = (total - dist) / (SPEED_KMH / 3.6);
    ui.tripEta.textContent = new Date(Date.now() + remainSec * 1000).toLocaleTimeString("ar-AE", { hour: "2-digit", minute: "2-digit" });

    // تنبيهات المناورات
    if (nextStep < steps.length && dist >= steps[nextStep].at - 250) {
      speak(steps[nextStep].text);
      addMsg("sys", "🧭 " + steps[nextStep].text);
      nextStep++;
    }

    state.simAnim = requestAnimationFrame(frame);
  }
  state.simAnim = requestAnimationFrame(frame);
}

function finishDrive() {
  state.driving = false;
  if (state.simAnim) cancelAnimationFrame(state.simAnim);
  ui.simRow.classList.add("hidden");
  reply(`🏁 وصلنا! حياك في ${state.dest ? state.dest.name : "وجهتك"}. عساها كانت رحلة حلوة.`,
    { speech: "وصلنا، الحمد لله على السلامة. عساها كانت رحلة حلوة" });
}

function stopDrive(announce) {
  if (!state.driving) { if (announce) reply("ما في قيادة شغالة حالياً."); return; }
  state.driving = false;
  if (state.simAnim) cancelAnimationFrame(state.simAnim);
  ui.simRow.classList.add("hidden");
  ui.startDriveBtn.classList.remove("hidden");
  if (announce) reply("⏹ وقفت القيادة الذاتية.");
}

ui.startDriveBtn.addEventListener("click", requestDrive);
ui.stopDriveBtn.addEventListener("click", () => stopDrive(true));

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function arManeuver(step) {
  const m = step.maneuver;
  const name = step.name ? " على " + step.name : "";
  const mod = m.modifier || "";
  if (m.type === "turn" || m.type === "end of road" || m.type === "fork") {
    if (mod.includes("left")) return "بعد شوي، لف يسار" + name;
    if (mod.includes("right")) return "بعد شوي، لف يمين" + name;
    return "كمل سيدا" + name;
  }
  if (m.type === "roundabout" || m.type === "rotary") return "ادخل الدوار وبعدين اطلع" + name;
  if (m.type === "merge") return "ادخل مع الطريج" + name;
  if (m.type === "on ramp") return "خذ المدخل" + name;
  if (m.type === "off ramp") return "خذ المخرج" + name;
  if (m.type === "arrive") return "الوجهة جدامك";
  return "كمل سيدا" + name;
}

// ---------- الطقس ----------
const weatherCodes = {
  0: ["صافٍ", "☀️"], 1: ["صافٍ غالبًا", "🌤️"], 2: ["غائم جزئيًا", "⛅"], 3: ["غائم", "☁️"],
  45: ["ضباب", "🌫️"], 48: ["ضباب متجمد", "🌫️"],
  51: ["رذاذ خفيف", "🌦️"], 53: ["رذاذ", "🌦️"], 55: ["رذاذ كثيف", "🌧️"],
  61: ["مطر خفيف", "🌦️"], 63: ["مطر", "🌧️"], 65: ["مطر غزير", "🌧️"],
  71: ["ثلج خفيف", "🌨️"], 73: ["ثلج", "🌨️"], 75: ["ثلج كثيف", "❄️"],
  80: ["زخات مطر", "🌦️"], 81: ["زخات مطر", "🌧️"], 82: ["زخات غزيرة", "⛈️"],
  95: ["عاصفة رعدية", "⛈️"], 96: ["عاصفة رعدية مع برد", "⛈️"], 99: ["عاصفة رعدية شديدة", "⛈️"],
};

async function fetchWeather() {
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${state.pos.lat}&longitude=${state.pos.lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`);
    const data = await res.json();
    state.weatherCache = data.current;
    const wc = weatherCodes[data.current.weather_code] || ["", "🌡️"];
    ui.weatherChip.textContent = `${wc[1]} ${Math.round(data.current.temperature_2m)}°`;
  } catch (_) {}
}
setInterval(fetchWeather, 15 * 60 * 1000);

async function doWeather() {
  if (!state.weatherCache) await fetchWeather();
  const w = state.weatherCache;
  if (!w) return reply("⚠️ ما قدرت أييب لك الجو الحين.");
  const wc = weatherCodes[w.weather_code] || ["غير معروف", "🌡️"];
  reply(`${wc[1]} الجو الحين: ${wc[0]}\n🌡️ الحرارة: ${Math.round(w.temperature_2m)}° (الإحساس: ${Math.round(w.apparent_temperature)}°)\n💧 الرطوبة: ${w.relative_humidity_2m}٪ — 💨 الرياح: ${Math.round(w.wind_speed_10m)} كم/س`,
    { speech: `الجو الحين ${wc[0]}، والحرارة ${Math.round(w.temperature_2m)} درجة، والرياح ${Math.round(w.wind_speed_10m)} كيلومتر في الساعة` });
}
ui.weatherChip.addEventListener("click", doWeather);

// ---------- الازدحام ----------
async function doTraffic() {
  if (!state.route) {
    return reply("حدد وجهتك أول عشان أشيك لك الزحمة على طريجك — قول: «وصلني…»");
  }
  const mins = Math.round(state.route.duration / 60);
  const km = state.route.distance / 1000;
  const avgSpeed = km / (state.route.duration / 3600);
  let level, icon;
  if (avgSpeed > 60) { level = "الطريج سالك"; icon = "🟢"; }
  else if (avgSpeed > 35) { level = "في زحمة متوسطة"; icon = "🟡"; }
  else { level = "في زحمة وايد"; icon = "🔴"; }
  reply(`${icon} ${level} على طريجك إلى ${state.dest.name}.\n⏱️ الوقت المتوقع: ${fmtMins(mins)} — متوسط السرعة: ${Math.round(avgSpeed)} كم/س.\n(تقدير تقريبي حسب بيانات الطريج)`,
    { speech: `${level} على طريجك. الوقت المتوقع ${fmtMins(mins)}` });
}

// ---------- الموسيقى ----------
let ytApiPromise = null;
let ytPlayer = null;
let ytQueue = [];
let ytPlayed = [];      // اللي انشغل من قبل — عشان ما نعيده إلا إذا خلصت القائمة
let ytErrorStreak = 0;  // مقاطع فاشلة متتالية — نوقف إذا كلها ما تشتغل
let ytLastAdvance = 0;  // وقت آخر انتقال — يمنع الانتقال المزدوج
let currentMusicQuery = "";

// حارس التشغيل المتواصل: حتى لو ضاع حدث «انتهى المقطع» ننقل للي بعده
setInterval(() => {
  try {
    if (ytPlayer && typeof ytPlayer.getPlayerState === "function" &&
        ytPlayer.getPlayerState() === YT.PlayerState.ENDED &&
        Date.now() - ytLastAdvance > 5000) {
      playNextTrack(false);
    }
  } catch (_) {}
}, 3000);

function loadYtApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ytApiPromise = null; reject(new Error("timeout")); }, 6000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { clearTimeout(timer); ytApiPromise = null; reject(new Error("blocked")); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

const MEDIA_ICONS = { music: "🎵", video: "🎬", news: "📺", radio: "📻", social: "📱" };
let mediaMode = "music";

async function doMusic(query, quiet) {
  return playMedia(query, { mode: "music", quiet });
}

// عرض مرئي: فيلم / فيديو / أخبار مباشرة
async function doVideo(query, opts = {}) {
  return playMedia(query, { ...opts, mode: opts.live ? "news" : "video" });
}

async function playMedia(query, opts = {}) {
  const mode = opts.mode || "music";
  stopCameras();
  stopRadio();
  const shouldResetSize = ui.musicPanel.classList.contains("hidden") || mode !== mediaMode;
  mediaMode = mode;
  currentMusicQuery = query;
  ui.mediaIcon.textContent = MEDIA_ICONS[mode] || "🎵";
  ui.musicTitle.textContent = query;
  if (shouldResetSize) resetMediaGeometry(mode);
  ui.musicPanel.classList.remove("hidden");
  ui.musicFrameWrap.innerHTML = '<div class="music-loading">🔍 أدور لك عليها…</div>';

  // 1) البحث عن الفيديوهات عبر الخادم المحلي
  let ids = [];
  try {
    let url = "/yt?q=" + encodeURIComponent(query);
    if (opts.live) url += "&live=1";
    if (opts.long) url += "&dur=long";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    ids = data.ids || [];
    if (!ids.length) throw new Error(data.error || "ما في نتائج");
  } catch (err) {
    addMsg("sys", "🔧 سبب المشكلة: " + err.message);
    ui.musicFrameWrap.innerHTML = "";
    ui.musicPanel.classList.add("hidden");
    window.open("https://www.youtube.com/results?search_query=" + encodeURIComponent(query), "_blank");
    reply("ما قدرت أدور من داخل التطبيق، فتحت لك يوتيوب في نافذة ثانية 🎵");
    return;
  }

  if (!opts.quiet) {
    if (mode === "news") reply("📺 حاضر، بشغل لك الأخبار المباشرة.\nاسحب النافذة من فوق لتحريكها، ومن الركن ◣ لتغيير حجمها، أو قول «ملء الشاشة».", { speech: "حاضر، بشغل لك الأخبار المباشرة" });
    else if (mode === "video") reply(`🎬 حاضر، بعرض لك: ${query}\nاسحب النافذة من فوق لتحريكها، ومن الركن ◣ لتغيير حجمها، أو قول «ملء الشاشة».`, { speech: `حاضر، بعرض لك ${query}` });
    else reply(`🎵 حاضر، بشغل لك: ${query} — وبكمل تشغيل اللي بعدها لين ما تقول لي «وقف الموسيقى»\n(إذا ما بدأ الصوت بروحه اضغط تشغيل — المتصفح يمنع التشغيل التلقائي أول مرة)`, { speech: `حاضر، بشغل لك ${query}، وبكمل الأغاني اللي بعدها` });
  }

  // 2) المشغل الذكي (يتخطى المقاطع الممنوعة تلقائيًا)
  try {
    await loadYtApi();
    playYtQueue(ids);
    return;
  } catch (_) {
    addMsg("sys", "ℹ️ مشغل يوتيوب المتقدم محجوب (مانع إعلانات؟) — أستخدم التضمين المباشر");
  }

  // 3) احتياط: تضمين مباشر بدون API
  plainEmbed(ids);
}

function playYtQueue(ids) {
  ytQueue = ids.slice();
  ytPlayed = [];
  ytErrorStreak = 0;
  const first = ytQueue.shift();
  ytPlayed.push(first);
  destroyYtPlayer();
  ui.musicFrameWrap.innerHTML = '<div id="ytPlayerDiv"></div>';
  ytPlayer = new YT.Player("ytPlayerDiv", {
    width: "100%",
    height: "100%",
    videoId: first,
    playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
    events: {
      onReady: (e) => {
        try {
          const fr = e.target.getIframe();
          fr.style.width = "100%"; fr.style.height = "100%";
          e.target.playVideo();
        } catch (_) {}
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) ytErrorStreak = 0;
        // انتهى المقطع → نكمل تلقائيًا على اللي بعده لين ما يقول المستخدم «وقف»
        if (e.data === YT.PlayerState.ENDED) playNextTrack(false);
      },
      onError: () => playNextTrack(true),
    },
  });
}

async function playNextTrack(fromError) {
  if (!ytPlayer) return;
  ytLastAdvance = Date.now();
  if (fromError) {
    ytErrorStreak++;
    if (ytErrorStreak >= 10) {
      ui.musicFrameWrap.innerHTML = "";
      ui.musicPanel.classList.add("hidden");
      reply("ما حصلت مقطع يشتغل داخل التطبيق لهالطلب — جرّب اسم ثاني 🎵");
      return;
    }
    addMsg("sys", "⏭️ هالمقطع ما يسمح بتشغيله هني — نقلت للي بعده");
  }

  let next = ytQueue.shift();
  if (!next) {
    // خلصت القائمة → ندور مقاطع يديدة بنفس الطلب، وإذا ما في نعيد من الأول
    try {
      const res = await fetch("/yt?q=" + encodeURIComponent(currentMusicQuery), { cache: "no-store" });
      const data = await res.json();
      const fresh = (data.ids || []).filter(id => !ytPlayed.includes(id));
      ytQueue = fresh.length ? fresh : ytPlayed.slice();
    } catch (_) {
      ytQueue = ytPlayed.slice();
    }
    next = ytQueue.shift();
  }
  if (!ytPlayer) return; // المستخدم وقف الموسيقى أثناء البحث
  if (!next) {
    ui.musicFrameWrap.innerHTML = "";
    ui.musicPanel.classList.add("hidden");
    reply("ما حصلت مقطع يشتغل داخل التطبيق لهالطلب — جرّب اسم ثاني 🎵");
    return;
  }

  ytPlayed.push(next);
  if (ytPlayed.length > 100) ytPlayed = ytPlayed.slice(-50);
  try { ytPlayer.loadVideoById(next); } catch (_) {}
}

function plainEmbed(ids) {
  destroyYtPlayer();
  ui.musicFrameWrap.innerHTML = "";
  const list = ids.slice(0, 15);
  const first = list.shift();
  const iframe = document.createElement("iframe");
  iframe.allow = "autoplay; encrypted-media";
  iframe.allowFullscreen = true;
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.display = "block";
  // playlist + loop → يشغل باقي المقاطع ورا بعض ويعيد من الأول لما تخلص
  const playlist = list.concat(first).join(",");
  iframe.src = `https://www.youtube.com/embed/${first}?autoplay=1&rel=0&playsinline=1&loop=1&playlist=${playlist}`;
  ui.musicFrameWrap.appendChild(iframe);
}

function destroyYtPlayer() {
  if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }
}

function stopMusic() {
  destroyYtPlayer();
  stopCameras();
  stopRadio();
  ytQueue = [];
  ytPlayed = [];
  mediaFullscreen(false);
  ui.musicFrameWrap.innerHTML = "";
  ui.musicPanel.classList.add("hidden");
  reply(mediaMode === "music" ? "⏹ وقفت لك الموسيقى." : mediaMode === "camera" ? "⏹ سكرت لك الكاميرا." : mediaMode === "radio" ? "⏹ وقفت لك الراديو." : mediaMode === "social" ? "⏹ سكرت لك نافذة التواصل." : "⏹ وقفت لك العرض.");
}
ui.closeMusicBtn.addEventListener("click", stopMusic);
$("openYtBtn").addEventListener("click", () => {
  if (currentMusicQuery) window.open("https://www.youtube.com/results?search_query=" + encodeURIComponent(currentMusicQuery), "_blank");
});

// ---------- نافذة العرض: مقاسات، تحريك، تغيير حجم، ملء الشاشة ----------
function resetMediaGeometry(mode) {
  const p = ui.musicPanel;
  p.classList.remove("media-max");
  p.style.left = p.style.top = p.style.right = p.style.bottom = "";
  if (mode === "music") {
    p.style.width = ""; p.style.height = "";
  } else {
    // نافذة أكبر للأفلام والفيديو والأخبار
    p.style.width = Math.min(680, innerWidth - 24) + "px";
    p.style.height = Math.min(440, Math.round(innerHeight * 0.6)) + "px";
  }
}

function mediaFullscreen(on) {
  const p = ui.musicPanel;
  if (on) {
    p.classList.add("media-max");
    // ملء شاشة حقيقي إذا سمح المتصفح — وإلا يكفي وضع التغطية الكاملة داخل التطبيق
    if (p.requestFullscreen) { try { p.requestFullscreen().catch(() => {}); } catch (_) {} }
  } else {
    p.classList.remove("media-max");
    if (document.fullscreenElement) { try { document.exitFullscreen().catch(() => {}); } catch (_) {} }
  }
}

ui.fullscreenBtn.addEventListener("click", () => {
  const full = ui.musicPanel.classList.contains("media-max") || document.fullscreenElement === ui.musicPanel;
  mediaFullscreen(!full);
});

// خروج من ملء الشاشة بزر Esc → رجّع النافذة لحجمها
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) ui.musicPanel.classList.remove("media-max");
});

(function initMediaWindow() {
  const p = ui.musicPanel;
  const header = $("musicHeader");
  const handle = $("mediaResize");

  // تحويل النافذة لإحداثيات مطلقة قبل التحريك/التحجيم
  function toAbs() {
    const r = p.getBoundingClientRect();
    p.style.left = r.left + "px";
    p.style.top = r.top + "px";
    p.style.right = "auto";
    p.style.bottom = "auto";
    return r;
  }

  function track(el, onMove) {
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      if (document.fullscreenElement === p || p.classList.contains("media-max")) return;
      e.preventDefault();
      const r = toAbs();
      const sx = e.clientX, sy = e.clientY;
      // الآي-فريم يسرق أحداث الماوس — نعطله مؤقتًا أثناء السحب
      ui.musicFrameWrap.style.pointerEvents = "none";
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => onMove(r, ev.clientX - sx, ev.clientY - sy);
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        ui.musicFrameWrap.style.pointerEvents = "";
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }

  // السحب من الشريط العلوي
  track(header, (r, dx, dy) => {
    p.style.left = Math.min(Math.max(r.left + dx, 60 - r.width), innerWidth - 60) + "px";
    p.style.top = Math.min(Math.max(r.top + dy, 0), innerHeight - 50) + "px";
  });

  // تغيير الحجم من الركن السفلي الأيسر (الحافة اليمنى تظل ثابتة)
  track(handle, (r, dx, dy) => {
    const w = Math.min(Math.max(r.width - dx, 260), innerWidth - 8);
    const h = Math.min(Math.max(r.height + dy, 180), innerHeight - 8);
    p.style.left = (r.right - w) + "px";
    p.style.width = w + "px";
    p.style.height = h + "px";
  });
})();

// ---------- الراديو والإذاعات ----------
let radioStations = [];
let radioIdx = 0;
let radioTryCount = 0;
let radioAdvancing = false;
const radioAudio = new Audio();
radioAudio.addEventListener("error", () => {
  if (mediaMode === "radio" && radioAudio.getAttribute("src")) radioFail();
});

let radioHls = null;
let hlsLibPromise = null;

function loadHlsLib() {
  if (window.Hls) return Promise.resolve();
  if (hlsLibPromise) return hlsLibPromise;
  hlsLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
    s.onload = () => resolve();
    s.onerror = () => { hlsLibPromise = null; reject(new Error("hls-lib")); };
    document.head.appendChild(s);
  });
  return hlsLibPromise;
}

function stopRadio() {
  if (radioHls) { try { radioHls.destroy(); } catch (_) {} radioHls = null; }
  try { radioAudio.pause(); radioAudio.removeAttribute("src"); radioAudio.load(); } catch (_) {}
}

async function doRadio(query) {
  destroyYtPlayer();
  stopCameras();
  stopRadio();
  ytQueue = []; ytPlayed = [];
  const shouldResetSize = ui.musicPanel.classList.contains("hidden") || mediaMode !== "radio";
  mediaMode = "radio";
  ui.mediaIcon.textContent = "📻";
  ui.musicTitle.textContent = query ? "راديو: " + query : "الإذاعات المحلية";
  if (shouldResetSize) resetMediaGeometry("video");
  ui.musicPanel.classList.remove("hidden");
  ui.musicFrameWrap.innerHTML = '<div class="music-loading">📻 أدور لك المحطات…</div>';

  try {
    const res = await fetch("/radio?q=" + encodeURIComponent(query || ""), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const sts = data.stations || [];
    if (!sts.length) throw new Error(data.error || "ما في محطات");
    radioStations = sts;
    radioTryCount = 0;
    renderRadioUI();
    reply(query
      ? `📻 حاضر، بشغل لك إذاعة ${sts[0].name}`
      : `📻 هذي الإذاعات المحلية — بشغل لك ${sts[0].name}.\nاضغط أي محطة ثانية من القائمة، أو قول «غير المحطة».`,
      { speech: `حاضر، بشغل لك ${sts[0].name}` });
    playRadioStation(0);
  } catch (err) {
    ui.musicFrameWrap.innerHTML = "";
    ui.musicPanel.classList.add("hidden");
    reply("⚠️ ما قدرت أييب المحطات" + (query ? ` لـ«${query}»` : "") + " — جرّب اسم ثاني أو شيك على النت.");
  }
}

function renderRadioUI() {
  const box = document.createElement("div");
  box.className = "radio-box";
  box.innerHTML = '<div class="radio-now"><span id="radioStatus">…</span><span id="radioName"></span></div><div class="radio-list" id="radioList"></div>';
  ui.musicFrameWrap.innerHTML = "";
  ui.musicFrameWrap.appendChild(box);
  const list = box.querySelector("#radioList");
  radioStations.forEach((st, i) => {
    const b = document.createElement("button");
    b.className = "radio-st";
    b.textContent = "📻 " + st.name;
    b.title = st.name;
    b.addEventListener("click", () => { radioTryCount = 0; playRadioStation(i); });
    list.appendChild(b);
  });
}

function updateRadioUI(status) {
  const n = $("radioName"), s = $("radioStatus");
  const st = radioStations[radioIdx];
  if (n) n.textContent = st ? st.name : "";
  if (s) s.textContent = status;
  document.querySelectorAll(".radio-st").forEach((b, i) => b.classList.toggle("active", i === radioIdx));
}

async function playRadioStation(i) {
  if (!radioStations.length) return;
  radioIdx = ((i % radioStations.length) + radioStations.length) % radioStations.length;
  const st = radioStations[radioIdx];
  radioTryCount++;
  updateRadioUI("⏳ أتصل…");

  if (radioHls) { try { radioHls.destroy(); } catch (_) {} radioHls = null; }
  try { radioAudio.pause(); radioAudio.removeAttribute("src"); } catch (_) {}

  const isHls = /\.m3u8/i.test(st.url);
  if (isHls && !radioAudio.canPlayType("application/vnd.apple.mpegurl")) {
    // بث HLS — نشغله عبر مكتبة hls.js لأن المتصفح ما يدعمه مباشرة
    try {
      await loadHlsLib();
      if (mediaMode !== "radio" || radioStations[radioIdx] !== st) return;
      if (!window.Hls || !Hls.isSupported()) throw new Error("no-hls");
      radioHls = new Hls();
      radioHls.loadSource(st.url);
      radioHls.attachMedia(radioAudio);
      radioHls.on(Hls.Events.ERROR, (ev, d) => { if (d && d.fatal) radioFail(); });
    } catch (_) { radioFail(); return; }
  } else {
    radioAudio.src = st.url;
  }

  radioAudio.play()
    .then(() => { radioTryCount = 0; updateRadioUI("🔴 مباشر"); })
    .catch((err) => {
      if (err && err.name === "NotAllowedError") {
        // المتصفح مانع التشغيل التلقائي — يبا لمسة من المستخدم
        updateRadioUI("▶️ اضغط أي محطة للتشغيل");
        addMsg("sys", "ℹ️ المتصفح يمنع التشغيل التلقائي أول مرة — اضغط المحطة من القائمة");
      } else if (err && err.name === "AbortError") {
        // تبديل سريع بين المحطات — طبيعي
      } else radioFail();
    });
}

function radioFail() {
  if (mediaMode !== "radio" || radioAdvancing) return;
  radioAdvancing = true;
  setTimeout(() => { radioAdvancing = false; }, 600);
  if (radioTryCount >= Math.min(radioStations.length, 6)) {
    updateRadioUI("⚠️ البث متعطل");
    reply("⚠️ جربت كم محطة وما اشتغل البث — جرّب من يديد بعد شوي أو اطلب إذاعة ثانية.");
    return;
  }
  addMsg("sys", "⏭️ هالمحطة ما اشتغلت — أجرب اللي بعدها");
  playRadioStation(radioIdx + 1);
}

// ---------- التواصل الاجتماعي ----------
// المنصات تمنع التضمين داخل الصفحة (X-Frame-Options) — نفتحها بنوافذ مستقلة
// والمتصفح يحفظ جلسة الدخول، فتسجل مرة وحدة بس
const SOCIAL_APPS = {
  whatsapp: { name: "واتساب", glyph: "💬", url: "https://web.whatsapp.com", cls: "s-wa", hint: "أول مرة: امسح رمز QR من واتساب تلفونك" },
  telegram: { name: "تيليجرام", glyph: "✈️", url: "https://web.telegram.org/a/", cls: "s-tg", hint: "أول مرة: سجل برقمك أو رمز QR" },
  tiktok: { name: "تيك توك", glyph: "🎵", url: "https://www.tiktok.com", cls: "s-tt", hint: "تصفح بدون دخول أو سجل حسابك" },
  x: { name: "إكس", glyph: "𝕏", url: "https://x.com", cls: "s-x", hint: "سجل دخولك أول مرة بس" },
  snapchat: { name: "سناب شات", glyph: "👻", url: "https://web.snapchat.com", cls: "s-sc", hint: "سجل دخولك أول مرة بس" },
};

function openSocial(key, fromClick) {
  const app = SOCIAL_APPS[key];
  if (!app) return;
  const w = Math.min(520, Math.round(screen.width * 0.42));
  const h = Math.min(880, screen.height - 80);
  const win = window.open(app.url, "byd_social_" + key,
    `width=${w},height=${h},left=${Math.max(0, screen.width - w - 30)},top=30`);
  if (win) {
    reply(`📱 فتحت لك ${app.name} بنافذة جنب التطبيق.` + (fromClick ? "" : `\n(${app.hint})`), { speech: `فتحت لك ${app.name}` });
  } else {
    // المتصفح منع النافذة المنبثقة (الأوامر الصوتية ما تعتبر لمسة) — نعرض المركز ليضغط البطاقة
    doSocialHub(true);
    addMsg("sys", `ℹ️ المتصفح يحتاج لمسة منك — اضغط بطاقة ${app.name}`);
  }
}

function doSocialHub(quiet) {
  destroyYtPlayer();
  stopCameras();
  stopRadio();
  ytQueue = []; ytPlayed = [];
  const shouldResetSize = ui.musicPanel.classList.contains("hidden") || mediaMode !== "social";
  mediaMode = "social";
  ui.mediaIcon.textContent = "📱";
  ui.musicTitle.textContent = "التواصل";
  if (shouldResetSize) resetMediaGeometry("video");
  ui.musicPanel.classList.remove("hidden");

  const grid = document.createElement("div");
  grid.className = "social-grid";
  Object.keys(SOCIAL_APPS).forEach((key) => {
    const app = SOCIAL_APPS[key];
    const card = document.createElement("button");
    card.className = "social-card " + app.cls;
    card.innerHTML = `<span class="social-glyph">${app.glyph}</span><span class="social-name">${app.name}</span><span class="social-hint">${app.hint}</span>`;
    card.addEventListener("click", () => openSocial(key, true));
    grid.appendChild(card);
  });
  ui.musicFrameWrap.innerHTML = "";
  ui.musicFrameWrap.appendChild(grid);
  if (!quiet) reply("📱 هذا مركز التواصل — اضغط أي منصة وبفتحها لك بنافذة جنب التطبيق. تسجل دخولك مرة وحدة بس والمتصفح يحفظها.", { speech: "هذا مركز التواصل، اضغط المنصة اللي تباها" });
}

// ---------- الكاميرات (كاميرات الجهاز + USB) ----------
let camStreams = [];

function stopCameras() {
  camStreams.forEach(s => { try { s.getTracks().forEach(tr => tr.stop()); } catch (_) {} });
  camStreams = [];
}

async function listCams() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === "videoinput");
}

function camCell(stream, label, mirror) {
  const cell = document.createElement("div");
  cell.className = "cam-cell";
  const v = document.createElement("video");
  v.autoplay = true; v.playsInline = true; v.muted = true;
  v.srcObject = stream;
  if (mirror) v.style.transform = "scaleX(-1)"; // الأمامية معكوسة مثل المرايا — أريح للعين
  const tag = document.createElement("span");
  tag.className = "cam-label";
  tag.textContent = label;
  cell.appendChild(v); cell.appendChild(tag);
  return cell;
}

async function doCamera(view) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return reply("⚠️ هالجهاز أو المتصفح ما يدعم الكاميرات.");
  }
  destroyYtPlayer();
  stopCameras();
  stopRadio();
  ytQueue = []; ytPlayed = [];
  const shouldResetSize = ui.musicPanel.classList.contains("hidden") || mediaMode !== "camera";
  mediaMode = "camera";
  const titles = { front: "الكاميرا الأمامية", rear: "الكاميرا الخلفية", "360": "عرض 360 — كل الكاميرات" };
  ui.mediaIcon.textContent = "📷";
  ui.musicTitle.textContent = titles[view] || "الكاميرا";
  if (shouldResetSize) resetMediaGeometry("video");
  ui.musicPanel.classList.remove("hidden");
  ui.musicFrameWrap.innerHTML = '<div class="music-loading">📷 أشغل لك الكاميرا…</div>';

  try {
    if (view === "360") {
      // إذن مبدئي عشان تظهر أسماء الكاميرات، بعدين نعرضها كلها في شبكة وحدة
      const initial = await navigator.mediaDevices.getUserMedia({ video: true });
      const cams = await listCams();
      initial.getTracks().forEach(tr => tr.stop());
      if (!cams.length) throw new Error("no-cam");

      const grid = document.createElement("div");
      grid.className = "cam-grid" + (cams.length === 1 ? " one" : "");
      ui.musicFrameWrap.innerHTML = "";
      ui.musicFrameWrap.appendChild(grid);

      let ok = 0;
      for (let i = 0; i < cams.length && i < 4; i++) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cams[i].deviceId } } });
          camStreams.push(s);
          grid.appendChild(camCell(s, cams[i].label || "كاميرا " + (i + 1), false));
          ok++;
        } catch (_) {}
      }
      if (!ok) throw new Error("no-cam");
      if (ok === 1) reply("📷 عرض 360 الكامل يحتاج أكثر من كاميرا موصولة — حاليًا في كاميرا وحدة فعرضتها لك. وصّل كاميرات USB إضافية (وحدة للخلف ووحدة للأمام) وبجمعها لك كلها في شاشة وحدة.", { speech: "حاليًا في كاميرا وحدة بس، وصل كاميرات زيادة وبجمعها لك كلها" });
      else reply(`📷 عرض 360 — ${ok} كاميرات شغالة مع بعض. قول «ملء الشاشة» إذا تبا أكبرها.`, { speech: "هذا عرض كل الكاميرات مع بعض" });
    } else {
      const facing = view === "front" ? "user" : "environment";
      const initial = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
      const cams = await listCams();
      // نحاول نطابق الكاميرا المطلوبة بالاسم — وإلا بالترتيب
      const wantRe = view === "front" ? /front|user|face|أمام/i : /back|rear|environment|خلف/i;
      let target = cams.find(c => wantRe.test(c.label || ""));
      if (!target && cams.length > 1) target = view === "front" ? cams[0] : cams[cams.length - 1];
      let stream = initial;
      const currentId = (initial.getVideoTracks()[0].getSettings() || {}).deviceId;
      if (target && currentId && target.deviceId !== currentId) {
        initial.getTracks().forEach(tr => tr.stop());
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: target.deviceId } } });
      }
      camStreams.push(stream);
      ui.musicFrameWrap.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "cam-grid one";
      wrap.appendChild(camCell(stream, titles[view], view === "front"));
      ui.musicFrameWrap.appendChild(wrap);
      reply(view === "front" ? "📷 شغلت لك الكاميرا الأمامية." : "📷 شغلت لك الكاميرا الخلفية.", { speech: view === "front" ? "شغلت لك الكاميرا الأمامية" : "شغلت لك الكاميرا الخلفية" });
    }
  } catch (err) {
    stopCameras();
    ui.musicFrameWrap.innerHTML = "";
    ui.musicPanel.classList.add("hidden");
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) reply("⚠️ لازم تسمح باستخدام الكاميرا من المتصفح عشان أعرضها لك.");
    else if ((err && err.name === "NotFoundError") || (err && err.message === "no-cam")) reply("⚠️ ما لقيت أي كاميرا موصولة بهالجهاز.");
    else reply("⚠️ ما قدرت أشغل الكاميرا" + (err && err.name ? " (" + err.name + ")" : "") + ".");
  }
}

// ---------- الموقع الحالي ----------
async function doWhereAmI() {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&accept-language=ar&lat=${state.pos.lat}&lon=${state.pos.lng}`);
    const data = await res.json();
    const name = data.display_name ? data.display_name.split(",").slice(0, 3).join("،") : "موقع غير معروف";
    map.setView([state.pos.lat, state.pos.lng], 16);
    reply(`📍 انت الحين في: ${name}`);
  } catch (_) {
    reply(`📍 إحداثياتك: ${state.pos.lat.toFixed(4)}, ${state.pos.lng.toFixed(4)}`);
  }
}

// ---------- معلومات السيارة ----------
function doCarInfo() {
  reply(carModel().info, { speech: carModel().infoSpeech });
}

// ---------- Claude AI ----------
async function askClaude(text) {
  if (!state.settings.apiKey) {
    return reply("ما فهمت طلبك من أوامري المدمجة 🤔\nجرّب: «وصلني…»، «شحال الجو؟»، «شغل أغنية…»\nوإذا تبا الذكاء الاصطناعي الكامل (يرد على أي سؤال) ضيف مفتاح Claude API من الإعدادات ⚙️");
  }

  addMsg("sys", "🤖 أفكر…");
  state.chatHistory.push({ role: "user", content: text });
  if (state.chatHistory.length > 12) state.chatHistory = state.chatHistory.slice(-12);

  const sysPrompt = `أنت مساعد ذكي داخل سيارة BYD ${carModel().name} (Leopard ${state.settings.carModel}). ترد دائمًا باللهجة الإماراتية بأسلوب ودود ومختصر (جمل قصيرة لأن الرد يُنطق صوتيًا للسايق). استخدم كلمات إماراتية مثل: هلا والله، شحالك، وايد، زين، تبا، الحين، عساك، طريج.
معلومات حالية: موقع السيارة تقريبًا (خط عرض ${state.pos.lat.toFixed(3)}، خط طول ${state.pos.lng.toFixed(3)}).${state.dest ? ` الوجهة الحالية: ${state.dest.name}.` : ""}${state.weatherCache ? ` الحرارة الآن ${Math.round(state.weatherCache.temperature_2m)} درجة.` : ""}
إذا طلب المستخدم فعلًا يمكن للتطبيق تنفيذه، أضف في نهاية ردك سطرًا منفصلًا بهذا الشكل بالضبط:
[CMD]{"action":"navigate","query":"اسم المكان"}
الأفعال المتاحة: navigate (الذهاب لمكان)، music (تشغيل أغنية، مع query)، video (عرض فيلم أو فيديو أو أي محتوى مرئي، مع query)، news (أخبار مباشرة)، camera (عرض كاميرا الجهاز، مع view: front أو rear أو 360)، radio (تشغيل إذاعة، مع query اختياري باسم المحطة — بدونه يعرض الإذاعات الإماراتية)، next_station (المحطة التالية)، social (فتح منصة تواصل، مع app: whatsapp أو telegram أو tiktok أو x أو snapchat — بدون app يفتح مركز التواصل)، stop_music (إيقاف أي تشغيل أو عرض)، fullscreen (ملء الشاشة)، unfullscreen (تصغير العرض)، drive (بدء القيادة الذاتية)، stop (إيقافها)، weather، traffic، cancel_route.
لا تدّعِ أنك تتحكم بالسيارة الحقيقية — القيادة الذاتية هنا محاكاة على الخريطة.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": state.settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        system: sysPrompt,
        messages: state.chatHistory,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      state.chatHistory.pop();
      if (res.status === 401) return reply("⚠️ مفتاح API مب صحيح — شيك على الإعدادات.");
      return reply("⚠️ في خطأ من خدمة الذكاء الاصطناعي: " + (err.error?.message || res.status));
    }

    const data = await res.json();
    let answer = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    state.chatHistory.push({ role: "assistant", content: answer });

    // استخراج الأمر إن وجد
    let cmd = null;
    const cmdMatch = answer.match(/\[CMD\](\{.*\})/s);
    if (cmdMatch) {
      try { cmd = JSON.parse(cmdMatch[1]); } catch (_) {}
      answer = answer.replace(/\[CMD\]\{.*\}/s, "").trim();
    }

    if (answer) reply(answer);
    if (cmd) runClaudeCmd(cmd);
  } catch (err) {
    state.chatHistory.pop();
    reply("⚠️ ما قدرت أوصل لخدمة الذكاء الاصطناعي. تأكد من النت.");
  }
}

function runClaudeCmd(cmd) {
  switch (cmd.action) {
    case "navigate": if (cmd.query) doNavigate(cmd.query); break;
    case "music": doMusic(cmd.query || "موسيقى هادئة"); break;
    case "video": doVideo(cmd.query || "مقاطع منوعة"); break;
    case "news": doVideo("أخبار بث مباشر", { live: true }); break;
    case "camera": doCamera(cmd.view === "front" ? "front" : cmd.view === "360" ? "360" : "rear"); break;
    case "radio": doRadio(cmd.query || ""); break;
    case "next_station": if (mediaMode === "radio" && radioStations.length) { radioTryCount = 0; playRadioStation(radioIdx + 1); } break;
    case "social": cmd.app && SOCIAL_APPS[cmd.app] ? openSocial(cmd.app) : doSocialHub(); break;
    case "fullscreen": mediaFullscreen(true); break;
    case "unfullscreen": mediaFullscreen(false); break;
    case "stop_music": stopMusic(); break;
    case "drive": requestDrive(); break;
    case "stop": stopDrive(true); break;
    case "weather": doWeather(); break;
    case "traffic": doTraffic(); break;
    case "cancel_route": cancelRoute(true); break;
  }
}

// ---------- نافذة التأكيد ----------
function showConfirm(title, text, cb) {
  ui.confirmTitle.textContent = title;
  ui.confirmText.textContent = text;
  ui.confirmModal.classList.remove("hidden");
  state.awaitingConfirm = cb;
}
function hideConfirm() { ui.confirmModal.classList.add("hidden"); }

ui.confirmYes.addEventListener("click", () => {
  const fn = state.awaitingConfirm; state.awaitingConfirm = null; hideConfirm();
  if (fn) fn(true);
});
ui.confirmNo.addEventListener("click", () => {
  const fn = state.awaitingConfirm; state.awaitingConfirm = null; hideConfirm();
  if (fn) fn(false);
});

// ---------- الإعدادات ----------
ui.settingsBtn.addEventListener("click", () => {
  ui.apiKeyInput.value = state.settings.apiKey;
  ui.autoListenChk.checked = state.settings.autoListen;
  ui.ttsChk.checked = state.settings.tts;
  if (ui.voiceSel) ui.voiceSel.value = state.settings.voice;
  if (ui.carModelSel) ui.carModelSel.value = state.settings.carModel;
  ui.settingsModal.classList.remove("hidden");
});
ui.settingsSave.addEventListener("click", () => {
  state.settings.apiKey = ui.apiKeyInput.value.trim();
  state.settings.autoListen = ui.autoListenChk.checked;
  state.settings.tts = ui.ttsChk.checked;
  const prevVoice = state.settings.voice;
  const prevModel = state.settings.carModel;
  if (ui.voiceSel) state.settings.voice = ui.voiceSel.value;
  if (ui.carModelSel) state.settings.carModel = ui.carModelSel.value;
  localStorage.setItem("byd_api_key", state.settings.apiKey);
  localStorage.setItem("byd_auto_listen", state.settings.autoListen ? "1" : "0");
  localStorage.setItem("byd_tts", state.settings.tts ? "1" : "0");
  localStorage.setItem("byd_voice", state.settings.voice);
  localStorage.setItem("byd_model", state.settings.carModel);
  applyCarModel();
  ui.settingsModal.classList.add("hidden");
  addMsg("sys", "✅ حفظت الإعدادات." + (state.settings.apiKey ? " الذكاء الاصطناعي الكامل شغال 🤖" : ""));
  if (state.settings.carModel !== prevModel) {
    reply(`🚙 تم! سيارتك الحين ${carModel().name} — كل شي بيتكلم على أساسها.`, { speech: `تم، سيارتك الحين ${carModel().speech}` });
  }
  if (state.settings.tts && state.settings.voice !== prevVoice) {
    speak(state.settings.voice === "ar-AE-FatimaNeural"
      ? "هلا، أنا فاطمة. من الحين بكلمك بهالصوت"
      : "هلا، أنا حمدان. من الحين بكلمك بهالصوت");
  }
});
ui.settingsClose.addEventListener("click", () => ui.settingsModal.classList.add("hidden"));

// ---------- الترحيب ----------
applyCarModel();
setTimeout(() => {
  addMsg("bot", `👋 هلا والله! حياك في مساعد BYD ${carModel().name}\n🎤 اضغط المايك وقول مثلًا: «وصلني المطار» أو «شحال الجو؟» أو «شغل أغنية»`);
  speak(`هلا والله، حياك في مساعد بي واي دي ${carModel().speech}. اضغط المايك وقول لي وين تبا تروح، أو اسألني اللي تباه`);
}, 800);
