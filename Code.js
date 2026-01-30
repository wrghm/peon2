/*******************************************************
 * PEON2 — Code.gs (PATCHER + MSE + THEMES)
 *
 * Naprawia
 * 1) Patchuje projekt przez Script API RAW
 * 2) Dodaje Patch Themes (wizualne tryby) jako osobny plik HTML
 * 3) Naprawia duplikację status mentalis
 *    - stary MSE jest ukrywany
 *    - patch MSE renderuje się tylko raz
 *
 * Wymóg
 * - W konsoli Apps Script włącz Apps Script API
 * - W manifest appsscript.json musisz mieć scope script.projects i script.projects.readonly
 *******************************************************/

function doGet(e) {
  return HtmlService
    .createTemplateFromFile("index")
    .evaluate()
    .setTitle("peon 2")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent()
}

function includeOptional(filename) {
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent()
  } catch (e) {
    return ""
  }
}

/***********************
 * PATCHER (RAW API)
 ***********************/

function applyPatches() {
  const patches = getPatches_()
  const scriptId = ScriptApp.getScriptId()

  Logger.log("[PEON2] Pobieranie plików projektu")
  let files
  try {
    files = getFilesRaw_(scriptId)
  } catch (e) {
    Logger.log("[PEON2] BŁĄD POBIERANIA: " + safeErr_(e))
    return
  }

  const byName = {}
  files.forEach(f => { byName[f.name] = f })

  let changed = 0
  const report = []

  patches.forEach(p => {
    try {
      if (p.mode === "upsertFile") {
        const res = upsertFile_(files, byName, p)
        if (res === "NOOP") report.push("NOOP: upsert " + p.file)
        else if (res === "OK") { changed++; report.push("OK: upsert " + p.file) }
        else report.push("SKIP: upsert " + p.file + " (" + res + ")")
        return
      }

      const file = byName[p.file]
      if (!file) {
        report.push("SKIP: brak pliku '" + p.file + "'")
        return
      }

      if (file.type !== "HTML" && file.type !== "SERVER_JS") {
        report.push("SKIP: " + p.file + " ma typ " + file.type)
        return
      }

      const before = file.source || ""
      const after = applyOnePatch_(before, p)

      if (after === before) {
        report.push("NOOP: " + p.file + " (" + p.id + ")")
        return
      }

      file.source = after
      changed++
      report.push("OK: " + p.file + " (" + p.id + ")")
    } catch (err) {
      report.push("FAIL: " + (p.file || "?") + " (" + (p.id || "?") + ") => " + safeErr_(err))
    }
  })

  Logger.log(report.join("\n"))

  if (changed <= 0) {
    Logger.log("[PEON2] Brak zmian do zapisania")
    return
  }

  Logger.log("[PEON2] Zapisywanie zmian (" + changed + ")")
  try {
    updateFilesRaw_(scriptId, files)
    Logger.log("[PEON2] SUKCES: zapisano zmiany")
  } catch (e) {
    Logger.log("[PEON2] BŁĄD ZAPISYWANIA: " + safeErr_(e))
    Logger.log("[PEON2] Jeśli to 403 lub PERMISSION_DENIED, to brakuje scope lub Apps Script API nie jest włączone")
  }
}

function previewPatches() {
  const patches = getPatches_()
  const scriptId = ScriptApp.getScriptId()

  let files
  try {
    files = getFilesRaw_(scriptId)
  } catch (e) {
    Logger.log("[PEON2] BŁĄD POBIERANIA: " + safeErr_(e))
    return
  }

  const byName = {}
  files.forEach(f => { byName[f.name] = f })

  const report = []

  patches.forEach(p => {
    if (p.mode === "upsertFile") {
      const existing = byName[p.file]
      if (!existing) {
        report.push("WILL CREATE: " + p.file + " (type=" + (p.type || "HTML") + ")")
        return
      }
      const before = existing.source || ""
      const after = String(p.source || "")
      if ((p.guard && before.includes(p.guard)) || before === after) report.push("NOOP: upsert " + p.file)
      else report.push("WILL CHANGE: upsert " + p.file + " Δlen=" + Math.abs(after.length - before.length))
      return
    }

    const file = byName[p.file]
    if (!file) { report.push("SKIP: brak pliku " + p.file); return }

    const before = file.source || ""
    const after = applyOnePatch_(before, p)

    if (after === before) report.push("NOOP: " + p.file + " (" + p.id + ")")
    else report.push("WILL CHANGE: " + p.file + " (" + p.id + ") Δlen=" + Math.abs(after.length - before.length))
  })

  Logger.log(report.join("\n"))
}

/***********************
 * RAW API
 ***********************/

function getFilesRaw_(scriptId) {
  const url = "https://script.googleapis.com/v1/projects/" + scriptId + "/content"
  const token = ScriptApp.getOAuthToken()
  const params = {
    method: "get",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json"
    },
    muteHttpExceptions: true
  }

  const res = UrlFetchApp.fetch(url, params)
  if (res.getResponseCode() !== 200) {
    throw new Error(res.getResponseCode() + " " + res.getContentText())
  }
  return JSON.parse(res.getContentText()).files || []
}

function updateFilesRaw_(scriptId, files) {
  const url = "https://script.googleapis.com/v1/projects/" + scriptId + "/content"
  const token = ScriptApp.getOAuthToken()
  const params = {
    method: "put",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json"
    },
    payload: JSON.stringify({ files: files }),
    muteHttpExceptions: true
  }

  const res = UrlFetchApp.fetch(url, params)
  if (res.getResponseCode() !== 200) {
    throw new Error(res.getResponseCode() + " " + res.getContentText())
  }
}

/***********************
 * PATCH ENGINE
 ***********************/

function applyOnePatch_(src, p) {
  if (p.guard && src.includes(p.guard)) return src

  if (p.mode === "replace") {
    const re = new RegExp(p.pattern, p.flags || "m")
    return src.replace(re, p.replacement)
  }

  if (p.mode === "insertAfter") {
    const re = new RegExp(p.anchor, p.flags || "m")
    if (!re.test(src)) return src
    return src.replace(re, m => m + p.insert)
  }

  if (p.mode === "insertBefore") {
    const re = new RegExp(p.anchor, p.flags || "m")
    if (!re.test(src)) return src
    return src.replace(re, m => p.insert + m)
  }

  return src
}

function upsertFile_(files, byName, p) {
  const name = p.file
  const type = p.type || "HTML"
  const src = String(p.source || "")

  if (!name) return "MISSING_NAME"
  if (!src) return "MISSING_SOURCE"
  if (type !== "HTML" && type !== "SERVER_JS") return "BAD_TYPE"

  const existing = byName[name]
  if (existing) {
    const before = existing.source || ""
    if (p.guard && before.includes(p.guard)) return "NOOP"
    if (before === src && existing.type === type) return "NOOP"
    existing.type = type
    existing.source = src
    return "OK"
  }

  const fileObj = { name: name, type: type, source: src }
  files.push(fileObj)
  byName[name] = fileObj
  return "OK"
}

function safeErr_(e) {
  try {
    if (!e) return "unknown"
    if (e.message) return String(e.message)
    return String(e)
  } catch (_) {
    return "unknown"
  }
}

/***********************
 * PATCH DEFINITIONS
 ***********************/

function getPatches_() {
  const PATCHER_HTML = `<!-- Patcher.html -->
<script>
(function () {
  const NS = "peon2"
  const KEY = NS + ".patches.applied"

  function _loadApplied() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}") }
    catch (_) { return {} }
  }
  function _saveApplied(obj) {
    localStorage.setItem(KEY, JSON.stringify(obj || {}))
  }
  function isApplied(patchId) {
    const a = _loadApplied()
    return !!a[patchId]
  }
  function markApplied(patchId) {
    const a = _loadApplied()
    a[patchId] = new Date().toISOString()
    _saveApplied(a)
  }

  function log() { console.log.apply(console, ["[PEON2][PATCHER]"].concat([].slice.call(arguments))) }
  function warn() { console.warn.apply(console, ["[PEON2][PATCHER]"].concat([].slice.call(arguments))) }

  window.PEON2_PATCHER = {
    patches: [],
    register(patch) {
      if (!patch || !patch.id || typeof patch.apply !== "function") {
        throw new Error("Patch must have {id, apply()}")
      }
      this.patches.push(patch)
    },
    applyAll() {
      for (const p of this.patches) {
        try {
          if (isApplied(p.id)) {
            log("skip " + p.id + " (already applied)")
            continue
          }
          const res = p.apply()
          if (res && typeof res.then === "function") {
            res.then(() => { markApplied(p.id); log("applied async " + p.id) })
               .catch(err => { warn("failed async " + p.id, err) })
          } else {
            markApplied(p.id)
            log("applied " + p.id)
          }
        } catch (err) {
          warn("failed " + p.id, err)
        }
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      if (window.PEON2_PATCHER) window.PEON2_PATCHER.applyAll()
    }, 0)
  })
})()
</script>
<!-- PEON2_PATCHER_V1_GUARD -->
`

  const PATCH_02_THEME_HTML = `<!-- PATCH_02_THEME.html -->
<script>
(function () {
  const PATCH_ID = "PATCH_02_THEME_V1"
  const KEY = "peon2.ui.theme"

  function ensureToolbar() {
    let bar = document.getElementById("peon2ThemeBar")
    if (bar) return bar

    bar = document.createElement("div")
    bar.id = "peon2ThemeBar"
    bar.innerHTML = \`
      <style>
        :root{
          --bg:#f6f7fb;
          --card:#ffffff;
          --text:#111827;
          --muted:#6b7280;
          --border:rgba(0,0,0,0.14);
          --accent:#2563eb;
        }
        body[data-theme="classic"]{
          --bg:#f6f7fb;
          --card:#ffffff;
          --text:#111827;
          --muted:#6b7280;
          --border:rgba(0,0,0,0.14);
          --accent:#2563eb;
        }
        body[data-theme="dark"]{
          --bg:#0b1220;
          --card:#0f1a2b;
          --text:#e5e7eb;
          --muted:#9ca3af;
          --border:rgba(255,255,255,0.14);
          --accent:#60a5fa;
        }
        body[data-theme="clinic"]{
          --bg:#f3faf8;
          --card:#ffffff;
          --text:#0f172a;
          --muted:#475569;
          --border:rgba(15,23,42,0.14);
          --accent:#0d9488;
        }
        body[data-theme="contrast"]{
          --bg:#ffffff;
          --card:#ffffff;
          --text:#000000;
          --muted:#111111;
          --border:#000000;
          --accent:#000000;
        }

        body{background:var(--bg);color:var(--text)}
        .peon2-card{background:var(--card);border:1px solid var(--border);border-radius:12px}
        .peon2ThemeBar{
          position:sticky;top:0;z-index:50;
          display:flex;gap:10px;align-items:center;
          padding:10px 12px;margin:0 0 10px 0;
          background:var(--card);
          border-bottom:1px solid var(--border)
        }
        .peon2ThemeBar label{font-size:12px;color:var(--muted)}
        .peon2ThemeBar select{
          padding:8px 10px;border-radius:10px;
          border:1px solid var(--border);
          background:var(--card);color:var(--text)
        }
        .peon2ThemeBar .hint{font-size:12px;color:var(--muted)}
      </style>

      <div class="peon2ThemeBar">
        <label for="peon2ThemeSel">Motyw</label>
        <select id="peon2ThemeSel">
          <option value="classic">Classic</option>
          <option value="dark">Dark</option>
          <option value="clinic">Clinic</option>
          <option value="contrast">High contrast</option>
        </select>
        <span class="hint">Zapisuje się lokalnie</span>
      </div>
    \`

    document.body.prepend(bar)
    return bar
  }

  function getTheme() {
    try { return localStorage.getItem(KEY) || "" } catch (_) { return "" }
  }

  function setTheme(t) {
    try { localStorage.setItem(KEY, t) } catch (_) {}
    document.body.setAttribute("data-theme", t)
  }

  function apply() {
    ensureToolbar()
    const sel = document.getElementById("peon2ThemeSel")
    const cur = getTheme() || document.body.getAttribute("data-theme") || "classic"
    document.body.setAttribute("data-theme", cur)
    sel.value = cur
    sel.addEventListener("change", () => setTheme(sel.value))
  }

  function register() {
    window.PEON2_PATCHER.register({
      id: PATCH_ID,
      apply: () => apply()
    })
  }

  (function waitForPatcher() {
    let i = 0
    const max = 80
    const t = setInterval(() => {
      i++
      if (window.PEON2_PATCHER && typeof window.PEON2_PATCHER.register === "function") {
        clearInterval(t)
        register()
      }
      if (i >= max) clearInterval(t)
    }, 50)
  })()
})()
</script>
<!-- PATCH_02_THEME_V1_GUARD -->
`

  const PATCH_01_MSE_HTML = `<!-- PATCH_01_MSE.html -->
<script>
(function () {
  const PATCH_ID = "PATCH_01_MSE_V3"

  function $(sel, root=document) { return root.querySelector(sel) }
  function $all(sel, root=document) { return Array.from(root.querySelectorAll(sel)) }

  function ensureHost() {
    return document.getElementById("modulesMount")
      || document.getElementById("modulesHost")
      || document.getElementById("ModulesHost")
      || document.body
  }

  function hideOldMse() {
    const old1 = document.getElementById("mse")
    const old2 = document.getElementById("MSE")
    if (old1) old1.style.display = "none"
    if (old2) old2.style.display = "none"
  }

  function ensureState() {
    if (!window.PEON2_STATE) window.PEON2_STATE = {}
    if (!window.PEON2_STATE.mse_v3) window.PEON2_STATE.mse_v3 = {}
    return window.PEON2_STATE.mse_v3
  }

  function setDeep(obj, path, val) {
    const parts = path.split(".")
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {}
      cur = cur[k]
    }
    cur[parts[parts.length - 1]] = val
  }

  function getDeep(obj, path, fallback) {
    const parts = path.split(".")
    let cur = obj
    for (const k of parts) {
      if (!cur || typeof cur !== "object" || !(k in cur)) return fallback
      cur = cur[k]
    }
    if (cur === undefined || cur === null) return fallback
    return cur
  }

  function checkboxRow(id, label) {
    return \`
      <label class="mse3-row">
        <input type="checkbox" data-mse3="\${id}">
        <span>\${label}</span>
      </label>
    \`
  }

  function textRow(path, label, placeholder) {
    return \`
      <div class="mse3-row mse3-text">
        <div class="mse3-label">\${label}</div>
        <input type="text" data-mse3="\${path}" placeholder="\${placeholder || ""}">
      </div>
    \`
  }

  function render() {
    hideOldMse()

    const host = ensureHost()

    let wrap = document.getElementById("mse3")
    if (wrap) return wrap

    wrap = document.createElement("section")
    wrap.id = "mse3"
    wrap.className = "peon2-card"
    wrap.innerHTML = \`
      <style>
        #mse3.peon2-card{margin:12px 0;padding:14px;border-radius:12px}
        #mse3 h2{margin:0 0 10px 0;font-size:18px}
        #mse3 h3{margin:14px 0 8px 0;font-size:14px;opacity:.9}
        #mse3 .mse3-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        #mse3 .mse3-block{padding:10px;border-radius:10px;border:1px solid var(--border);background:rgba(0,0,0,0.02)}
        body[data-theme="dark"] #mse3 .mse3-block{background:rgba(255,255,255,0.04)}
        #mse3 .mse3-row{display:flex;align-items:flex-start;gap:8px;margin:6px 0;font-size:13px;line-height:1.3}
        #mse3 .mse3-row input[type="checkbox"]{transform:translateY(2px)}
        #mse3 .mse3-text{display:grid;grid-template-columns:160px 1fr;align-items:center;gap:10px;margin:8px 0}
        #mse3 .mse3-label{font-size:12px;opacity:.85}
        #mse3 input[type="text"]{width:100%;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13px}
        #mse3 .mse3-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
        #mse3 button{padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13px;cursor:pointer}
        #mse3 .mse3-output{margin-top:10px;width:100%;min-height:90px;padding:10px;border-radius:10px;border:1px dashed var(--border);background:rgba(0,0,0,0.01);font-size:13px;white-space:pre-wrap}
        body[data-theme="dark"] #mse3 .mse3-output{background:rgba(255,255,255,0.04)}
        @media (max-width:900px){#mse3 .mse3-grid{grid-template-columns:1fr}#mse3 .mse3-text{grid-template-columns:1fr}}
      </style>

      <h2>Status mentalis (MSE)</h2>

      <div class="mse3-grid">
        <div class="mse3-block">
          <h3>Kontakt i zachowanie</h3>
          \${checkboxRow("kontakt.logic","Kontakt logiczny i adekwatny")}
          \${checkboxRow("kontakt.nielogic","Kontakt utrudniony lub nielogiczny")}
          \${checkboxRow("kontakt.wspolpraca","Współpraca zachowana")}
          \${checkboxRow("kontakt.niewspolpraca","Współpraca ograniczona")}
          \${checkboxRow("zachowanie.psychomotor.spowolnienie","Spowolnienie psychoruchowe")}
          \${checkboxRow("zachowanie.psychomotor.pobudzenie","Pobudzenie psychoruchowe")}
          \${checkboxRow("zachowanie.niepokoj","Niepokój psychoruchowy")}
          \${checkboxRow("zachowanie.agresja","Zachowania agresywne")}
          \${textRow("zachowanie.inne","Inne","np. manieryzmy, stereotypie, dziwaczność, katatonia")}
        </div>

        <div class="mse3-block">
          <h3>Orientacja i świadomość</h3>
          \${checkboxRow("orientacja.auto.pelna","Orientacja autopsychiczna pełna")}
          \${checkboxRow("orientacja.auto.zaburzona","Orientacja autopsychiczna zaburzona")}
          \${checkboxRow("orientacja.allo.pelna","Orientacja allopsychiczna pełna")}
          \${checkboxRow("orientacja.allo.czesc","Orientacja allopsychiczna częściowo zaburzona")}
          \${checkboxRow("swiadomosc.przytomny","Przytomny")}
          \${checkboxRow("swiadomosc.zaburzona","Zaburzenia świadomości")}
          \${textRow("orientacja.uwagi","Uwagi","czas, miejsce, sytuacja")}
        </div>

        <div class="mse3-block">
          <h3>Mowa i tok myślenia</h3>
          \${checkboxRow("mowa.norma","Mowa prawidłowa")}
          \${checkboxRow("mowa.spowolniona","Mowa spowolniona")}
          \${checkboxRow("mowa.przyspieszona","Mowa przyspieszona")}
          \${checkboxRow("tok.logic","Tok myślenia logiczny")}
          \${checkboxRow("tok.rozkojarzenie","Rozkojarzenie lub zaburzenia kojarzenia")}
          \${checkboxRow("tok.ubogi","Ubogi tok myślenia")}
          \${checkboxRow("tok.natr","Natrętne myśli")}
          \${textRow("tok.inne","Inne","np. gonitwa myśli, lepkość, wielomówność")}
        </div>

        <div class="mse3-block">
          <h3>Nastrój i afekt</h3>
          \${textRow("afekt.nastroj","Nastrój","np. obniżony, labilny, euforyczny")}
          \${textRow("afekt.afekt","Afekt","np. spłycony, niedostosowany, napięty")}
          \${checkboxRow("afekt.anhedonia","Anhedonia")}
          \${checkboxRow("afekt.lek","Lęk")}
          \${checkboxRow("afekt.drazl","Drażliwość")}
          \${textRow("afekt.uwagi","Uwagi","jakość, zakres, kongruencja")}
        </div>

        <div class="mse3-block">
          <h3>Spostrzeganie</h3>
          \${checkboxRow("percepcja.brak","Bez objawów wytwórczych")}
          \${checkboxRow("percepcja.sluch","Omamy słuchowe")}
          \${checkboxRow("percepcja.wzrok","Omamy wzrokowe")}
          \${checkboxRow("percepcja.inne","Inne zaburzenia spostrzegania")}
          \${textRow("percepcja.opis","Opis","np. komentarze, dialogujące, sceniczne")}
        </div>

        <div class="mse3-block">
          <h3>Treści myślenia</h3>
          \${checkboxRow("tresci.uroj","Treści urojeniowe")}
          \${checkboxRow("tresci.ksob","Myśli ksobne")}
          \${checkboxRow("tresci.przesl","Myśli prześladowcze")}
          \${checkboxRow("tresci.samoos","Ruminacje samooskarżające")}
          \${checkboxRow("tresci.wielk","Treści wielkościowe")}
          \${textRow("tresci.opis","Opis","temat, stopień pewności, wpływ na zachowanie")}
        </div>

        <div class="mse3-block">
          <h3>Poznawcze</h3>
          \${checkboxRow("pozn.konc.ok","Koncentracja zachowana")}
          \${checkboxRow("pozn.konc.osl","Koncentracja osłabiona")}
          \${checkboxRow("pozn.pam.ok","Pamięć zachowana")}
          \${checkboxRow("pozn.pam.osl","Pamięć osłabiona")}
          \${checkboxRow("pozn.abstr","Zaburzenia myślenia abstrakcyjnego")}
          \${textRow("pozn.uwagi","Uwagi","uwaga, pamięć świeża, funkcje wykonawcze")}
        </div>

        <div class="mse3-block">
          <h3>Wgląd, krytycyzm, napęd</h3>
          \${checkboxRow("wglad.pel","Wgląd pełny")}
          \${checkboxRow("wglad.cz","Wgląd częściowy")}
          \${checkboxRow("wglad.br","Brak wglądu")}
          \${checkboxRow("kryt.zach","Krytycyzm zachowany")}
          \${checkboxRow("kryt.osl","Krytycyzm osłabiony")}
          \${checkboxRow("naped.osl","Napęd obniżony")}
          \${checkboxRow("naped.wzm","Napęd wzmożony")}
          \${textRow("wglad.uwagi","Uwagi","akceptacja leczenia, rozumienie objawów")}
        </div>
      </div>

      <h3>Ryzyko</h3>
      <div class="mse3-block">
        \${checkboxRow("ryz.si","Myśli samobójcze")}
        \${checkboxRow("ryz.plan","Plan samobójczy")}
        \${checkboxRow("ryz.nssi","Samouszkodzenia")}
        \${checkboxRow("ryz.hi","Myśli agresywne lub heteroagresja")}
        \${textRow("ryz.uwagi","Uwagi","ochrona, dostęp do środków, aktualna intencja")}
      </div>

      <div class="mse3-actions">
        <button type="button" id="mse3BuildShort">Generuj krótko</button>
        <button type="button" id="mse3BuildLong">Generuj szczegółowo</button>
        <button type="button" id="mse3Copy">Kopiuj</button>
      </div>

      <div id="mse3Out" class="mse3-output" contenteditable="true"></div>
    \`

    host.prepend(wrap)
    return wrap
  }

  function bind() {
    const st = ensureState()
    const root = document.getElementById("mse3")
    if (!root) return

    $all("[data-mse3]", root).forEach(el => {
      const key = el.getAttribute("data-mse3")
      if (el.type === "checkbox") el.checked = !!getDeep(st, key, false)
      else el.value = getDeep(st, key, "")

      el.addEventListener("change", () => {
        if (el.type === "checkbox") setDeep(st, key, !!el.checked)
        else setDeep(st, key, String(el.value || ""))
      })
      el.addEventListener("input", () => {
        if (el.type !== "checkbox") setDeep(st, key, String(el.value || ""))
      })
    })

    $("#mse3BuildShort", root).addEventListener("click", () => {
      $("#mse3Out", root).innerText = buildText("short")
    })
    $("#mse3BuildLong", root).addEventListener("click", () => {
      $("#mse3Out", root).innerText = buildText("long")
    })
    $("#mse3Copy", root).addEventListener("click", async () => {
      const t = $("#mse3Out", root).innerText || ""
      try { await navigator.clipboard.writeText(t) } catch (_) {}
    })
  }

  function buildText(mode) {
    const st = ensureState()
    const yes = p => !!getDeep(st, p, false)
    const txt = p => String(getDeep(st, p, "") || "").trim()

    const parts = []

    function cap(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s }
    function sent(arr){
      if (!arr.length) return ""
      const s = cap(arr[0]) + (arr.length > 1 ? ", " + arr.slice(1).join(", ") : "")
      return s + "."
    }

    {
      const a = []
      if (yes("kontakt.logic")) a.push("kontakt logiczny i adekwatny")
      if (yes("kontakt.nielogic")) a.push("kontakt utrudniony lub nielogiczny")
      if (yes("kontakt.wspolpraca")) a.push("współpraca zachowana")
      if (yes("kontakt.niewspolpraca")) a.push("współpraca ograniczona")
      if (yes("zachowanie.psychomotor.spowolnienie")) a.push("spowolnienie psychoruchowe")
      if (yes("zachowanie.psychomotor.pobudzenie")) a.push("pobudzenie psychoruchowe")
      if (yes("zachowanie.niepokoj")) a.push("niepokój psychoruchowy")
      if (yes("zachowanie.agresja")) a.push("zachowania agresywne")
      const other = txt("zachowanie.inne")
      if (other) a.push(other)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      if (yes("swiadomosc.przytomny")) a.push("przytomny")
      if (yes("swiadomosc.zaburzona")) a.push("zaburzenia świadomości")
      if (yes("orientacja.auto.pelna")) a.push("orientacja autopsychiczna pełna")
      if (yes("orientacja.auto.zaburzona")) a.push("orientacja autopsychiczna zaburzona")
      if (yes("orientacja.allo.pelna")) a.push("orientacja allopsychiczna pełna")
      if (yes("orientacja.allo.czesc")) a.push("orientacja allopsychiczna częściowo zaburzona")
      const uw = txt("orientacja.uwagi")
      if (uw) a.push("uwagi: " + uw)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      if (yes("mowa.norma")) a.push("mowa prawidłowa")
      if (yes("mowa.spowolniona")) a.push("mowa spowolniona")
      if (yes("mowa.przyspieszona")) a.push("mowa przyspieszona")
      if (yes("tok.logic")) a.push("tok myślenia logiczny")
      if (yes("tok.rozkojarzenie")) a.push("zaburzenia kojarzenia")
      if (yes("tok.ubogi")) a.push("ubogi tok myślenia")
      if (yes("tok.natr")) a.push("natrętne myśli")
      const other = txt("tok.inne")
      if (other) a.push(other)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      const n = txt("afekt.nastroj")
      if (n) a.push("nastrój: " + n)
      const af = txt("afekt.afekt")
      if (af) a.push("afekt: " + af)
      if (yes("afekt.anhedonia")) a.push("anhedonia")
      if (yes("afekt.lek")) a.push("lęk")
      if (yes("afekt.drazl")) a.push("drażliwość")
      const uw = txt("afekt.uwagi")
      if (uw) a.push("uwagi: " + uw)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      if (yes("percepcja.brak")) a.push("bez objawów wytwórczych")
      if (yes("percepcja.sluch")) a.push("omamy słuchowe")
      if (yes("percepcja.wzrok")) a.push("omamy wzrokowe")
      if (yes("percepcja.inne")) a.push("inne zaburzenia spostrzegania")
      const op = txt("percepcja.opis")
      if (op) a.push("opis: " + op)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      if (yes("tresci.uroj")) a.push("treści urojeniowe")
      if (yes("tresci.ksob")) a.push("myśli ksobne")
      if (yes("tresci.przesl")) a.push("myśli prześladowcze")
      if (yes("tresci.samoos")) a.push("ruminacje samooskarżające")
      if (yes("tresci.wielk")) a.push("treści wielkościowe")
      const op = txt("tresci.opis")
      if (op) a.push("opis: " + op)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      if (yes("pozn.konc.ok")) a.push("koncentracja zachowana")
      if (yes("pozn.konc.osl")) a.push("koncentracja osłabiona")
      if (yes("pozn.pam.ok")) a.push("pamięć zachowana")
      if (yes("pozn.pam.osl")) a.push("pamięć osłabiona")
      if (yes("pozn.abstr")) a.push("zaburzenia myślenia abstrakcyjnego")
      const uw = txt("pozn.uwagi")
      if (uw) a.push("uwagi: " + uw)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      if (yes("wglad.pel")) a.push("wgląd pełny")
      if (yes("wglad.cz")) a.push("wgląd częściowy")
      if (yes("wglad.br")) a.push("brak wglądu")
      if (yes("kryt.zach")) a.push("krytycyzm zachowany")
      if (yes("kryt.osl")) a.push("krytycyzm osłabiony")
      if (yes("naped.osl")) a.push("napęd obniżony")
      if (yes("naped.wzm")) a.push("napęd wzmożony")
      const uw = txt("wglad.uwagi")
      if (uw) a.push("uwagi: " + uw)
      const s = sent(a)
      if (s) parts.push(s)
    }

    {
      const a = []
      if (yes("ryz.si")) a.push("myśli samobójcze")
      if (yes("ryz.plan")) a.push("plan samobójczy")
      if (yes("ryz.nssi")) a.push("autoagresja")
      if (yes("ryz.hi")) a.push("ryzyko heteroagresji")
      const uw = txt("ryz.uwagi")
      if (uw) a.push("uwagi: " + uw)

      if (a.length) parts.push("Ryzyko: " + a.join(", ") + ".")
      else parts.push("Ryzyko: nie zgłasza myśli samobójczych, nie zgłasza zamiarów agresywnych.")
    }

    if (mode === "short") return parts.slice(0, 7).join("\\n")
    return parts.join("\\n")
  }

  function applyPatch() {
    window.PEON2_PATCHER.register({
      id: PATCH_ID,
      apply: () => { render(); bind() }
    })
  }

  (function waitForPatcher() {
    let i = 0
    const max = 80
    const t = setInterval(() => {
      i++
      if (window.PEON2_PATCHER && typeof window.PEON2_PATCHER.register === "function") {
        clearInterval(t)
        applyPatch()
      }
      if (i >= max) clearInterval(t)
    }, 50)
  })()
})()
</script>
<!-- PATCH_01_MSE_V3_GUARD -->
`

  return [
    {
      id: "upsert_patcher_v1",
      mode: "upsertFile",
      file: "Patcher",
      type: "HTML",
      source: PATCHER_HTML,
      guard: "PEON2_PATCHER_V1_GUARD"
    },
    {
      id: "upsert_patch_02_theme_v1",
      mode: "upsertFile",
      file: "PATCH_02_THEME",
      type: "HTML",
      source: PATCH_02_THEME_HTML,
      guard: "PATCH_02_THEME_V1_GUARD"
    },
    {
      id: "upsert_patch_01_mse_v3",
      mode: "upsertFile",
      file: "PATCH_01_MSE",
      type: "HTML",
      source: PATCH_01_MSE_HTML,
      guard: "PATCH_01_MSE_V3_GUARD"
    },
    {
      id: "index_add_patch_includes_v2",
      file: "index",
      mode: "insertBefore",
      anchor: "</body>",
      flags: "m",
      insert: "\n    <!-- PEON2 PATCHES -->\n    <?!= includeOptional('Patcher'); ?>\n    <?!= includeOptional('PATCH_02_THEME'); ?>\n    <?!= includeOptional('PATCH_01_MSE'); ?>\n",
      guard: "PEON2 PATCHES"
    }
  ]
}
