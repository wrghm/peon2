/*******************************************************
 * PEON2 — Code.gs (PATCHER + RAW Script API)
 * - preview: tylko GET
 * - apply: GET + PUT (wymaga włączonego Google Apps Script API i scope)
 *******************************************************/

function doGet(e) {
  return HtmlService
    .createTemplateFromFile("index")
    .evaluate()
    .setTitle("peon 2")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function includeOptional(filename) {
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
  } catch (e) {
    return "";
  }
}

/***********************
 * PATCHER v1
 ***********************/

function previewPatches() {
  const patches = getPatches_();
  const scriptId = ScriptApp.getScriptId();

  const files = getFilesRaw_(scriptId);
  const byName = indexByName_(files);

  const report = [];
  patches.forEach(p => {
    if (p.mode === "upsertFile") {
      const existing = byName[p.file];
      if (!existing) {
        report.push(`WILL CREATE: ${p.file} (type=${p.type || "HTML"})`);
        return;
      }
      const before = existing.source || "";
      const after = String(p.source || "");
      if ((p.guard && before.includes(p.guard)) || before === after) report.push(`NOOP: upsert ${p.file}`);
      else report.push(`WILL CHANGE: upsert ${p.file} Δlen=${Math.abs(after.length - before.length)}`);
      return;
    }

    const file = byName[p.file];
    if (!file) {
      report.push(`SKIP: brak pliku ${p.file}`);
      return;
    }

    const before = file.source || "";
    const after = applyOnePatch_(before, p);
    if (after === before) report.push(`NOOP: ${p.file} (${p.id})`);
    else report.push(`WILL CHANGE: ${p.file} (${p.id}) Δlen=${Math.abs(after.length - before.length)}`);
  });

  Logger.log(report.join("\n"));
}

function applyPatches() {
  const patches = getPatches_();
  const scriptId = ScriptApp.getScriptId();

  Logger.log("[PEON2] GET /content ...");
  let files = [];
  try {
    files = getFilesRaw_(scriptId);
  } catch (e) {
    Logger.log("[PEON2] FAIL GET: " + stringifyErr_(e));
    Logger.log("[PEON2] Sprawdź: włączone Google Apps Script API oraz scope w appsscript.json.");
    return;
  }

  const byName = indexByName_(files);
  let changed = 0;
  const report = [];

  patches.forEach(p => {
    try {
      if (p.mode === "upsertFile") {
        const res = upsertFile_(files, byName, p);
        if (res === "NOOP") report.push(`NOOP: upsert ${p.file}`);
        else if (res === "OK") { changed++; report.push(`OK: upsert ${p.file}`); }
        else report.push(`SKIP: upsert ${p.file} (${res})`);
        return;
      }

      const file = byName[p.file];
      if (!file) {
        report.push(`SKIP: brak pliku '${p.file}'`);
        return;
      }

      if (file.type !== "HTML" && file.type !== "SERVER_JS") {
        report.push(`SKIP: ${p.file} ma typ ${file.type}`);
        return;
      }

      const before = file.source || "";
      const after = applyOnePatch_(before, p);

      if (after === before) {
        report.push(`NOOP: ${p.file} (${p.id})`);
        return;
      }

      file.source = after;
      changed++;
      report.push(`OK: ${p.file} (${p.id})`);
    } catch (err) {
      report.push(`FAIL: ${p.file || "?"} (${p.id || "?"}) => ${stringifyErr_(err)}`);
    }
  });

  if (changed <= 0) {
    Logger.log("[PEON2] Brak zmian do zapisania.");
    Logger.log(report.join("\n"));
    return;
  }

  Logger.log(`[PEON2] PUT /content ... changed=${changed}`);
  try {
    updateFilesRaw_(scriptId, files);
    Logger.log("[PEON2] SUKCES! Zapisano zmiany.");
  } catch (e) {
    Logger.log("[PEON2] FAIL PUT: " + stringifyErr_(e));
    Logger.log("[PEON2] Najczęściej: niewłączone Google Apps Script API w projekcie Cloud lub brak scope script.projects.");
    Logger.log("[PEON2] Wskazówka: wejdź w Executions i otwórz szczegóły błędu HTTP (często 403 lub 404).");
  }

  Logger.log(report.join("\n"));
}

/***********************
 * RAW Script API
 ***********************/

function getFilesRaw_(scriptId) {
  const url = `https://script.googleapis.com/v1/projects/${scriptId}/content`;
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) throw new Error(`HTTP ${code}: ${body}`);
  return (JSON.parse(body).files || []);
}

function updateFilesRaw_(scriptId, files) {
  const url = `https://script.googleapis.com/v1/projects/${scriptId}/content`;
  const token = ScriptApp.getOAuthToken();
  const res = UrlFetchApp.fetch(url, {
    method: "put",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ files: files }),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) throw new Error(`HTTP ${code}: ${body}`);
}

/***********************
 * PATCH CORE
 ***********************/

function applyOnePatch_(src, p) {
  if (p.guard && src.includes(p.guard)) return src;

  if (p.mode === "replace") {
    const re = new RegExp(p.pattern, p.flags || "m");
    return src.replace(re, p.replacement);
  }

  if (p.mode === "insertAfter") {
    const re = new RegExp(p.anchor, p.flags || "m");
    if (!re.test(src)) return src;
    return src.replace(re, (m) => m + p.insert);
  }

  if (p.mode === "insertBefore") {
    const re = new RegExp(p.anchor, p.flags || "m");
    if (!re.test(src)) return src;
    return src.replace(re, (m) => p.insert + m);
  }

  return src;
}

function upsertFile_(files, byName, p) {
  const name = p.file;
  const type = p.type || "HTML";
  const src = String(p.source || "");

  if (!name) return "MISSING_NAME";
  if (!src) return "MISSING_SOURCE";
  if (type !== "HTML" && type !== "SERVER_JS") return "BAD_TYPE";

  const existing = byName[name];
  if (existing) {
    const before = existing.source || "";
    if (p.guard && before.includes(p.guard)) return "NOOP";
    if (before === src && existing.type === type) return "NOOP";
    existing.type = type;
    existing.source = src;
    return "OK";
  }

  const fileObj = { name: name, type: type, source: src };
  files.push(fileObj);
  byName[name] = fileObj;
  return "OK";
}

function indexByName_(files) {
  const byName = {};
  (files || []).forEach(f => { byName[f.name] = f; });
  return byName;
}

function stringifyErr_(e) {
  try {
    if (e && e.message) return String(e.message);
    return String(e);
  } catch (_) {
    return "Unknown error";
  }
}

/***********************
 * PATCH DEFINITIONS
 ***********************/
function getPatches_() {
  const PATCHER_HTML = `<!-- Patcher.html -->
<script>
(function () {
  const NS = "peon2";
  const KEY = NS + ".patches.applied";

  function _loadApplied() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); }
    catch (_) { return {}; }
  }
  function _saveApplied(obj) {
    localStorage.setItem(KEY, JSON.stringify(obj || {}));
  }
  function isApplied(patchId) {
    const a = _loadApplied();
    return !!a[patchId];
  }
  function markApplied(patchId) {
    const a = _loadApplied();
    a[patchId] = new Date().toISOString();
    _saveApplied(a);
  }

  function log() { console.log.apply(console, ["[PEON2][PATCHER]"].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ["[PEON2][PATCHER]"].concat([].slice.call(arguments))); }

  window.PEON2_PATCHER = {
    patches: [],
    register(patch) {
      if (!patch || !patch.id || typeof patch.apply !== "function") {
        throw new Error("Patch must have {id, apply()}");
      }
      this.patches.push(patch);
    },
    applyAll() {
      for (const p of this.patches) {
        try {
          if (isApplied(p.id)) { log("skip " + p.id); continue; }
          const res = p.apply();
          if (res && typeof res.then === "function") {
            res.then(() => { markApplied(p.id); log("applied async " + p.id); })
               .catch(err => { warn("failed async " + p.id, err); });
          } else {
            markApplied(p.id);
            log("applied " + p.id);
          }
        } catch (err) {
          warn("failed " + p.id, err);
        }
      }
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      if (window.PEON2_PATCHER) window.PEON2_PATCHER.applyAll();
    }, 0);
  });
})();
</script>
<!-- PEON2_PATCHER_V1_GUARD -->
`;

  const PATCH_01_MSE_HTML = `<!-- PATCH_01_MSE.html -->
<script>
(function () {
  const PATCH_ID = "PATCH_01_MSE_V2";
  function $(sel, root=document) { return root.querySelector(sel); }
  function $all(sel, root=document) { return Array.from(root.querySelectorAll(sel)); }

  function ensureHost() {
    return document.getElementById("modulesMount")
      || document.getElementById("modulesHost")
      || document.getElementById("ModulesHost")
      || document.body;
  }

  function ensureState() {
    if (!window.PEON2_STATE) window.PEON2_STATE = {};
    if (!window.PEON2_STATE.mse_v2) window.PEON2_STATE.mse_v2 = {};
    return window.PEON2_STATE.mse_v2;
  }

  function setDeep(obj, path, val) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = val;
  }

  function getDeep(obj, path, fallback="") {
    const parts = path.split(".");
    let cur = obj;
    for (const k of parts) {
      if (!cur || typeof cur !== "object" || !(k in cur)) return fallback;
      cur = cur[k];
    }
    return (cur === undefined || cur === null) ? fallback : cur;
  }

  function checkboxRow(id, label) {
    return \`
      <label class="mse2-row">
        <input type="checkbox" data-mse2="\${id}">
        <span>\${label}</span>
      </label>
    \`;
  }
  function textRow(path, label, placeholder) {
    return \`
      <div class="mse2-row mse2-text">
        <div class="mse2-label">\${label}</div>
        <input type="text" data-mse2="\${path}" placeholder="\${placeholder || ""}">
      </div>
    \`;
  }

  function render() {
    const host = ensureHost();

    const old = document.getElementById("mse") || document.getElementById("MSE");
    if (old) old.style.display = "none";

    let wrap = document.getElementById("mse2");
    if (wrap) return wrap;

    wrap = document.createElement("section");
    wrap.id = "mse2";
    wrap.className = "peon2-card";
    wrap.innerHTML = \`
      <style>
        #mse2.peon2-card{margin:12px 0;padding:14px;border:1px solid rgba(0,0,0,0.15);border-radius:12px;background:var(--p2-card,#fff);color:var(--p2-fg,#111);}
        #mse2 h2{margin:0 0 10px 0;font-size:18px;}
        #mse2 h3{margin:14px 0 8px 0;font-size:14px;opacity:.9;}
        #mse2 .mse2-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
        #mse2 .mse2-block{padding:10px;border-radius:10px;border:1px solid rgba(0,0,0,0.10);background:rgba(0,0,0,0.02);}
        #mse2 .mse2-row{display:flex;align-items:flex-start;gap:8px;margin:6px 0;font-size:13px;line-height:1.3;}
        #mse2 .mse2-row input[type="checkbox"]{transform:translateY(2px);}
        #mse2 .mse2-text{display:grid;grid-template-columns:160px 1fr;align-items:center;gap:10px;margin:8px 0;}
        #mse2 .mse2-label{font-size:12px;opacity:.85;}
        #mse2 input[type="text"]{width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,0.18);background:var(--p2-input,#fff);color:var(--p2-fg,#111);font-size:13px;}
        #mse2 .mse2-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;}
        #mse2 button{padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,0.2);background:var(--p2-btn,#fff);color:var(--p2-fg,#111);font-size:13px;cursor:pointer;}
        #mse2 .mse2-output{margin-top:10px;width:100%;min-height:90px;padding:10px;border-radius:10px;border:1px dashed rgba(0,0,0,0.25);background:rgba(0,0,0,0.01);font-size:13px;white-space:pre-wrap;}
        @media (max-width:900px){#mse2 .mse2-grid{grid-template-columns:1fr;}#mse2 .mse2-text{grid-template-columns:1fr;}}
      </style>

      <h2>Status mentalis (MSE)</h2>
      <div class="mse2-grid">
        <div class="mse2-block">
          <h3>Kontakt i zachowanie</h3>
          \${checkboxRow("kontakt.logic","Kontakt logiczny i adekwatny")}
          \${checkboxRow("kontakt.nielogic","Kontakt utrudniony lub nielogiczny")}
          \${checkboxRow("kontakt.wspolpraca","Współpraca zachowana")}
          \${checkboxRow("kontakt.niewspolpraca","Współpraca ograniczona")}
          \${checkboxRow("zachowanie.psychomotor.spowolnienie","Spowolnienie psychoruchowe")}
          \${checkboxRow("zachowanie.psychomotor.pobudzenie","Pobudzenie psychoruchowe")}
          \${checkboxRow("zachowanie.niepokoj","Niepokój psychoruchowy")}
          \${checkboxRow("zachowanie.agresja","Zachowania agresywne")}
          \${textRow("zachowanie.inne","Inne","np. manieryzmy, stereotypie, katatonia")}
        </div>

        <div class="mse2-block">
          <h3>Orientacja i świadomość</h3>
          \${checkboxRow("orientacja.auto.pelna","Orientacja autopsychiczna pełna")}
          \${checkboxRow("orientacja.auto.zaburzona","Orientacja autopsychiczna zaburzona")}
          \${checkboxRow("orientacja.allo.pelna","Orientacja allopsychiczna pełna")}
          \${checkboxRow("orientacja.allo.czesc","Orientacja allopsychiczna częściowo zaburzona")}
          \${checkboxRow("swiadomosc.przytomny","Przytomny")}
          \${checkboxRow("swiadomosc.zaburzona","Zaburzenia świadomości")}
          \${textRow("orientacja.uwagi","Uwagi","czas, miejsce, sytuacja")}
        </div>

        <div class="mse2-block">
          <h3>Mowa i tok myślenia</h3>
          \${checkboxRow("mowa.norma","Mowa prawidłowa")}
          \${checkboxRow("mowa.spowolniona","Mowa spowolniona")}
          \${checkboxRow("mowa.przyspieszona","Mowa przyspieszona")}
          \${checkboxRow("tok.logic","Tok myślenia logiczny")}
          \${checkboxRow("tok.rozkojarzenie","Rozkojarzenie")}
          \${checkboxRow("tok.ubogi","Ubogi tok myślenia")}
          \${checkboxRow("tok.natręctwa","Natrętne myśli")}
          \${textRow("tok.inne","Inne","np. gonitwa myśli, lepkość")}
        </div>

        <div class="mse2-block">
          <h3>Nastrój i afekt</h3>
          \${textRow("afekt.nastroj","Nastrój","np. obniżony, labilny")}
          \${textRow("afekt.afekt","Afekt","np. spłycony, napięty")}
          \${checkboxRow("afekt.anhedonia","Anhedonia")}
          \${checkboxRow("afekt.lek","Lęk")}
          \${checkboxRow("afekt.drazliwosc","Drażliwość")}
          \${textRow("afekt.uwagi","Uwagi","zakres, kongruencja")}
        </div>

        <div class="mse2-block">
          <h3>Spostrzeganie</h3>
          \${checkboxRow("percepcja.brak","Bez objawów wytwórczych")}
          \${checkboxRow("percepcja.sluchowe","Omamy słuchowe")}
          \${checkboxRow("percepcja.wzrokowe","Omamy wzrokowe")}
          \${checkboxRow("percepcja.inne","Inne zaburzenia spostrzegania")}
          \${textRow("percepcja.opis","Opis","np. komentarze, sceniczne")}
        </div>

        <div class="mse2-block">
          <h3>Treści myślenia</h3>
          \${checkboxRow("tresci.urojenia","Treści urojeniowe")}
          \${checkboxRow("tresci.ksobne","Myśli ksobne")}
          \${checkboxRow("tresci.przesladowcze","Myśli prześladowcze")}
          \${checkboxRow("tresci.samooskarzajace","Ruminacje samooskarżające")}
          \${checkboxRow("tresci.wielkosciowe","Treści wielkościowe")}
          \${textRow("tresci.opis","Opis","temat, wpływ na zachowanie")}
        </div>

        <div class="mse2-block">
          <h3>Poznawcze</h3>
          \${checkboxRow("poznawcze.koncentracja.ok","Koncentracja zachowana")}
          \${checkboxRow("poznawcze.koncentracja.oslabiona","Koncentracja osłabiona")}
          \${checkboxRow("poznawcze.pamiec.ok","Pamięć zachowana")}
          \${checkboxRow("poznawcze.pamiec.oslabiona","Pamięć osłabiona")}
          \${checkboxRow("poznawcze.abstrakcja.zab","Zaburzenia myślenia abstrakcyjnego")}
          \${textRow("poznawcze.uwagi","Uwagi","uwaga, pamięć świeża")}
        </div>

        <div class="mse2-block">
          <h3>Wgląd, krytycyzm, napęd</h3>
          \${checkboxRow("wglad.pelny","Wgląd pełny")}
          \${checkboxRow("wglad.czesc","Wgląd częściowy")}
          \${checkboxRow("wglad.brak","Brak wglądu")}
          \${checkboxRow("krytycyzm.zachowany","Krytycyzm zachowany")}
          \${checkboxRow("krytycyzm.oslabiony","Krytycyzm osłabiony")}
          \${checkboxRow("naped.oslabiony","Napęd obniżony")}
          \${checkboxRow("naped.wzmozony","Napęd wzmożony")}
          \${textRow("wglad.uwagi","Uwagi","akceptacja leczenia")}
        </div>
      </div>

      <h3>Ryzyko</h3>
      <div class="mse2-block">
        \${checkboxRow("ryzyko.si","Myśli samobójcze")}
        \${checkboxRow("ryzyko.plan","Plan samobójczy")}
        \${checkboxRow("ryzyko.nssi","Samouszkodzenia")}
        \${checkboxRow("ryzyko.hi","Myśli agresywne")}
        \${textRow("ryzyko.uwagi","Uwagi","ochrona, dostęp do środków")}
      </div>

      <div class="mse2-actions">
        <button type="button" id="mse2BuildShort">Generuj krótko</button>
        <button type="button" id="mse2BuildLong">Generuj szczegółowo</button>
        <button type="button" id="mse2Copy">Kopiuj</button>
      </div>

      <div id="mse2Out" class="mse2-output" contenteditable="true"></div>
    \`;

    host.prepend(wrap);
    return wrap;
  }

  function bind() {
    const st = ensureState();
    const root = document.getElementById("mse2");
    if (!root) return;

    $all("[data-mse2]", root).forEach(el => {
      const key = el.getAttribute("data-mse2");
      if (el.type === "checkbox") el.checked = !!getDeep(st, key, false);
      else el.value = getDeep(st, key, "");

      el.addEventListener("change", () => {
        if (el.type === "checkbox") setDeep(st, key, !!el.checked);
        else setDeep(st, key, String(el.value || ""));
      });
      el.addEventListener("input", () => {
        if (el.type !== "checkbox") setDeep(st, key, String(el.value || ""));
      });
    });

    $("#mse2BuildShort", root).addEventListener("click", () => {
      $("#mse2Out", root).innerText = buildText("short");
    });
    $("#mse2BuildLong", root).addEventListener("click", () => {
      $("#mse2Out", root).innerText = buildText("long");
    });
    $("#mse2Copy", root).addEventListener("click", async () => {
      const t = $("#mse2Out", root).innerText || "";
      try { await navigator.clipboard.writeText(t); } catch (_) {}
    });
  }

  function buildText(mode) {
    const st = ensureState();
    const yes = (p) => !!getDeep(st, p, false);
    const txt = (p) => String(getDeep(st, p, "") || "").trim();

    const parts = [];
    function cap(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function sent(arr){ return arr.length ? cap(arr[0]) + (arr.length>1 ? ", " + arr.slice(1).join(", ") : "") + "." : ""; }

    {
      const a = [];
      if (yes("kontakt.logic")) a.push("kontakt logiczny i adekwatny");
      if (yes("kontakt.nielogic")) a.push("kontakt utrudniony lub nielogiczny");
      if (yes("kontakt.wspolpraca")) a.push("współpraca zachowana");
      if (yes("kontakt.niewspolpraca")) a.push("współpraca ograniczona");
      if (yes("zachowanie.psychomotor.spowolnienie")) a.push("spowolnienie psychoruchowe");
      if (yes("zachowanie.psychomotor.pobudzenie")) a.push("pobudzenie psychoruchowe");
      if (yes("zachowanie.niepokoj")) a.push("niepokój psychoruchowy");
      if (yes("zachowanie.agresja")) a.push("zachowania agresywne");
      const other = txt("zachowanie.inne"); if (other) a.push(other);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      if (yes("swiadomosc.przytomny")) a.push("przytomny");
      if (yes("swiadomosc.zaburzona")) a.push("zaburzenia świadomości");
      if (yes("orientacja.auto.pelna")) a.push("orientacja autopsychiczna pełna");
      if (yes("orientacja.auto.zaburzona")) a.push("orientacja autopsychiczna zaburzona");
      if (yes("orientacja.allo.pelna")) a.push("orientacja allopsychiczna pełna");
      if (yes("orientacja.allo.czesc")) a.push("orientacja allopsychiczna częściowo zaburzona");
      const uw = txt("orientacja.uwagi"); if (uw) a.push("uwagi: " + uw);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      if (yes("mowa.norma")) a.push("mowa prawidłowa");
      if (yes("mowa.spowolniona")) a.push("mowa spowolniona");
      if (yes("mowa.przyspieszona")) a.push("mowa przyspieszona");
      if (yes("tok.logic")) a.push("tok myślenia logiczny");
      if (yes("tok.rozkojarzenie")) a.push("rozkojarzenie");
      if (yes("tok.ubogi")) a.push("ubogi tok myślenia");
      if (yes("tok.natręctwa")) a.push("natrętne myśli");
      const other = txt("tok.inne"); if (other) a.push(other);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      const n = txt("afekt.nastroj"); if (n) a.push("nastrój: " + n);
      const af = txt("afekt.afekt"); if (af) a.push("afekt: " + af);
      if (yes("afekt.anhedonia")) a.push("anhedonia");
      if (yes("afekt.lek")) a.push("lęk");
      if (yes("afekt.drazliwosc")) a.push("drażliwość");
      const uw = txt("afekt.uwagi"); if (uw) a.push("uwagi: " + uw);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      if (yes("percepcja.brak")) a.push("bez objawów wytwórczych");
      if (yes("percepcja.sluchowe")) a.push("omamy słuchowe");
      if (yes("percepcja.wzrokowe")) a.push("omamy wzrokowe");
      if (yes("percepcja.inne")) a.push("inne zaburzenia spostrzegania");
      const op = txt("percepcja.opis"); if (op) a.push("opis: " + op);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      if (yes("tresci.urojenia")) a.push("treści urojeniowe");
      if (yes("tresci.ksobne")) a.push("myśli ksobne");
      if (yes("tresci.przesladowcze")) a.push("myśli prześladowcze");
      if (yes("tresci.samooskarzajace")) a.push("ruminacje samooskarżające");
      if (yes("tresci.wielkosciowe")) a.push("treści wielkościowe");
      const op = txt("tresci.opis"); if (op) a.push("opis: " + op);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      if (yes("poznawcze.koncentracja.ok")) a.push("koncentracja zachowana");
      if (yes("poznawcze.koncentracja.oslabiona")) a.push("koncentracja osłabiona");
      if (yes("poznawcze.pamiec.ok")) a.push("pamięć zachowana");
      if (yes("poznawcze.pamiec.oslabiona")) a.push("pamięć osłabiona");
      if (yes("poznawcze.abstrakcja.zab")) a.push("zaburzenia myślenia abstrakcyjnego");
      const uw = txt("poznawcze.uwagi"); if (uw) a.push("uwagi: " + uw);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      if (yes("wglad.pelny")) a.push("wgląd pełny");
      if (yes("wglad.czesc")) a.push("wgląd częściowy");
      if (yes("wglad.brak")) a.push("brak wglądu");
      if (yes("krytycyzm.zachowany")) a.push("krytycyzm zachowany");
      if (yes("krytycyzm.oslabiony")) a.push("krytycyzm osłabiony");
      if (yes("naped.oslabiony")) a.push("napęd obniżony");
      if (yes("naped.wzmozony")) a.push("napęd wzmożony");
      const uw = txt("wglad.uwagi"); if (uw) a.push("uwagi: " + uw);
      const s = sent(a); if (s) parts.push(s);
    }

    {
      const a = [];
      if (yes("ryzyko.si")) a.push("myśli samobójcze");
      if (yes("ryzyko.plan")) a.push("plan samobójczy");
      if (yes("ryzyko.nssi")) a.push("autoagresja");
      if (yes("ryzyko.hi")) a.push("ryzyko heteroagresji");
      const uw = txt("ryzyko.uwagi"); if (uw) a.push("uwagi: " + uw);

      parts.push(a.length
        ? ("Ryzyko: " + a.join(", ") + ".")
        : "Ryzyko: nie zgłasza myśli samobójczych, nie zgłasza zamiarów agresywnych.");
    }

    return mode === "short" ? parts.slice(0, 7).join("\\n") : parts.join("\\n");
  }

  function applyPatch() {
    window.PEON2_PATCHER.register({
      id: PATCH_ID,
      apply: () => { render(); bind(); }
    });
  }

  (function waitForPatcher() {
    const max = 80;
    let i = 0;
    const t = setInterval(() => {
      i++;
      if (window.PEON2_PATCHER && typeof window.PEON2_PATCHER.register === "function") {
        clearInterval(t);
        applyPatch();
      }
      if (i >= max) clearInterval(t);
    }, 50);
  })();
})();
</script>
<!-- PATCH_01_MSE_V2_GUARD -->
`;

  // PATCH 02: tryby wizualne (theme)
  const PATCH_02_THEME_HTML = `<!-- PATCH_02_THEME.html -->
<script>
(function () {
  const PATCH_ID = "PATCH_02_THEME_V1";
  const KEY = "peon2.theme";

  function ensureTopbarSlot() {
    return document.querySelector("#topbar, .topbar, header") || document.body;
  }

  function applyTheme(name) {
    const root = document.documentElement;
    root.setAttribute("data-peon2-theme", name);

    // bazowe zmienne, bez ingerencji w resztę CSS
    const themes = {
      light:  { bg:"#f6f7fb", fg:"#111", card:"#fff", input:"#fff", btn:"#fff" },
      dark:   { bg:"#0f1218", fg:"#e9edf4", card:"#151a22", input:"#121722", btn:"#151a22" },
      hc:     { bg:"#000", fg:"#fff", card:"#000", input:"#000", btn:"#000" }
    };
    const t = themes[name] || themes.light;

    root.style.setProperty("--p2-bg", t.bg);
    root.style.setProperty("--p2-fg", t.fg);
    root.style.setProperty("--p2-card", t.card);
    root.style.setProperty("--p2-input", t.input);
    root.style.setProperty("--p2-btn", t.btn);

    try { localStorage.setItem(KEY, name); } catch (_) {}
  }

  function mountUI() {
    if (document.getElementById("peon2ThemePicker")) return;

    const host = ensureTopbarSlot();
    const wrap = document.createElement("div");
    wrap.id = "peon2ThemePicker";
    wrap.style.cssText = "position:sticky;top:0;z-index:9999;padding:8px 10px;border-bottom:1px solid rgba(0,0,0,0.08);background:var(--p2-card,#fff);color:var(--p2-fg,#111);display:flex;gap:10px;align-items:center;";

    wrap.innerHTML = \`
      <style>
        body{background:var(--p2-bg,#f6f7fb);color:var(--p2-fg,#111);}
        .peon2ThemeSel{padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,0.18);background:var(--p2-input,#fff);color:var(--p2-fg,#111);}
      </style>
      <div style="font-weight:600;">Widok</div>
      <select class="peon2ThemeSel" id="peon2ThemeSel">
        <option value="light">Jasny</option>
        <option value="dark">Ciemny</option>
        <option value="hc">Wysoki kontrast</option>
      </select>
      <div style="opacity:.75;font-size:12px;">zapamiętywane lokalnie</div>
    \`;

    // wstaw na samą górę body, żeby działało zawsze
    document.body.prepend(wrap);

    const sel = document.getElementById("peon2ThemeSel");
    const saved = (function(){ try { return localStorage.getItem(KEY) || "light"; } catch(_) { return "light"; } })();
    sel.value = saved;
    applyTheme(saved);

    sel.addEventListener("change", () => applyTheme(sel.value));
  }

  function applyPatch() {
    window.PEON2_PATCHER.register({ id: PATCH_ID, apply: () => mountUI() });
  }

  (function waitForPatcher() {
    const max = 80;
    let i = 0;
    const t = setInterval(() => {
      i++;
      if (window.PEON2_PATCHER && typeof window.PEON2_PATCHER.register === "function") {
        clearInterval(t);
        applyPatch();
      }
      if (i >= max) clearInterval(t);
    }, 50);
  })();
})();
</script>
<!-- PATCH_02_THEME_V1_GUARD -->
`;

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
      id: "upsert_patch_01_mse_v2",
      mode: "upsertFile",
      file: "PATCH_01_MSE",
      type: "HTML",
      source: PATCH_01_MSE_HTML,
      guard: "PATCH_01_MSE_V2_GUARD"
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
      id: "index_add_patch_includes_v2",
      file: "index",
      mode: "insertBefore",
      anchor: "</body>",
      flags: "m",
      insert: "\n    <!-- PEON2 PATCHES -->\n    <?!= includeOptional('Patcher'); ?>\n    <?!= includeOptional('PATCH_01_MSE'); ?>\n    <?!= includeOptional('PATCH_02_THEME'); ?>\n",
      guard: "PEON2 PATCHES"
    }
  ];
}
