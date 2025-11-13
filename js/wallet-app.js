import { QrFlow } from './qrflow.js';

let flowInstance = null;
async function flow() {
  if (!flowInstance) {
    flowInstance = await QrFlow.init({
      databaseURL: 'https://demoapp-6cc2a-default-rtdb.europe-west1.firebasedatabase.app/'
    });
  }
  return flowInstance;
}

const VIEWS = ['scan', 'wallet', 'share', 'done'];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const stateKey = 'walletState';
const settingsKey = 'walletSettings';
function loadState() { try { return JSON.parse(localStorage.getItem(stateKey)) || { cards: [] }; } catch { return { cards: [] }; } }
function saveState(s) { try { localStorage.setItem(stateKey, JSON.stringify(s)); } catch {} }
function loadSettings() {
  try {
    const raw = localStorage.getItem(settingsKey);
    if (!raw) return { hideSeedPrompt: false, advancedSeedOptions: false };
    const parsed = JSON.parse(raw) || {};
    if (typeof parsed.hideSeedPrompt !== 'boolean') parsed.hideSeedPrompt = false;
    if (typeof parsed.advancedSeedOptions !== 'boolean') parsed.advancedSeedOptions = true;
    return parsed;
  } catch {
    return { hideSeedPrompt: false, advancedSeedOptions: false };
  }
}
function saveSettings(s) { try { localStorage.setItem(settingsKey, JSON.stringify(s)); } catch {} }

let state = loadState();
let settings = loadSettings();
const pendingMeta = new Map();
let uiSchema = {};
let scenarioConfigs = {};
const scenarioAttrByKey = new Map();
let pendingShare = null; // { id, meta, candidates: Card[], selectedIndex: number }
let shareStatusUnsub = null; // unsubscribe for expired status listener

async function loadJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) { return null; }
}


function addCardFromSession(id, metaOverride) {
  const firstSchemaType = (() => { try { const keys = Object.keys(uiSchema || {}); return (keys && keys[0]) ? String(keys[0]).toUpperCase() : 'GENERIC'; } catch { return 'GENERIC'; } })();
  const meta = metaOverride || { type: firstSchemaType, issuer: 'Onbekend', payload: {} };
  const cType = canonicalType(meta.type || '');
  const now = Date.now();
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const card = {
    id: `${cType}-${now}`,
    type: cType,
    issuer: meta.issuer,
    issuedAt: now,
    expiresAt: now + oneYear,
    expanded: false,
    payload: meta.payload,
  };
  state.cards.push(card);
  if (settings.advancedSeedOptions === false) { settings.advancedSeedOptions = true; saveSettings(settings); }
  saveState(state);
  renderCards();
}

function formatDate(ts) {
  if (!ts) return '';
  try { const d = new Date(ts); const dd = String(d.getDate()).padStart(2,'0'); const mm = String(d.getMonth()+1).padStart(2,'0'); const yyyy = d.getFullYear(); return `${dd}-${mm}-${yyyy}`; } catch { return ''; }
}
function formatDateTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${HH}:${MM}`;
  } catch { return ''; }
}
function formatCurrencyEUR(val) {
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[^0-9.,-]/g,'').replace(',','.'));
  if (!isFinite(n)) return '';
  try { return new Intl.NumberFormat('nl-NL',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n); } catch { return `€ ${Math.round(n).toLocaleString('nl-NL')}`; }
}
function computeStatus(card) { const now = Date.now(); return card.expiresAt && card.expiresAt < now ? 'verlopen' : 'geldig'; }

function renderDetailsFromSchema(type, payload) {
  const schema = uiSchema && uiSchema[type];
  if (!schema) {
    const frag = document.createElement('div');
    frag.className = 'mt-2 grid grid-cols-1 gap-1 font-inter text-sm';
    Object.entries(payload || {}).forEach(([k, v]) => {
      const row = document.createElement('div');
      row.innerHTML = `<strong>${k}</strong>: ${Array.isArray(v) ? v.join(', ') : (typeof v === 'object' ? JSON.stringify(v) : String(v))}`;
      frag.appendChild(row);
    });
    return frag;
  }
  const order = schema.order || Object.keys(payload || {});
  const labels = schema.labels || {};
  const format = schema.format || {};
  const frag = document.createElement('div');
  frag.className = 'mt-2 grid grid-cols-1 gap-1 font-inter text-sm';
  order.forEach((key) => {
    const raw = payload ? payload[key] : undefined;
    let val = raw;
    const fmt = format[key];
    if (fmt === 'date') {
      if (typeof raw === 'string') { try { val = formatDate(new Date(raw).getTime()); } catch { val = raw; } }
      else if (typeof raw === 'number') { val = formatDate(raw); }
    } else if (fmt === 'boolean') {
      val = raw ? 'ja' : 'nee';
    } else if (fmt === 'eur') {
      val = formatCurrencyEUR(raw);
    } else if (Array.isArray(raw)) {
      val = raw.join(', ');
    } else if (typeof raw === 'object' && raw != null) {
      val = JSON.stringify(raw);
    }
    const row = document.createElement('div');
    row.innerHTML = `<strong>${labels[key] || key}</strong>: ${val ?? ''}`;
    frag.appendChild(row);
  });
  return frag;
}

function schemaForType(type) {
  const key = canonicalType(type || '');
  if (!uiSchema) return null;
  return uiSchema[key] || uiSchema[String(key).replace(/_/g, ' ')] || null;
}

function normalizePinValue(pinValue) {
  const raw = pinValue == null ? '' : String(pinValue);
  const digitsOnly = raw.replace(/\D/g, '');
  return digitsOnly || '123456';
}

function getConfiguredPinValue() {
  try {
    const scanner = document.querySelector('[data-qrflow="scanner"]');
    const attr = scanner?.getAttribute('data-pin-value');
    return normalizePinValue(attr);
  } catch {
    return '123456';
  }
}

function setScenarioAttributes(configs) {
  scenarioConfigs = configs || {};
  scenarioAttrByKey.clear();
  if (!configs || typeof configs !== 'object') return;
  Object.entries(configs).forEach(([scenarioId, cfg]) => {
    if (!cfg || typeof cfg !== 'object') return;
    const attrs = cfg.request && cfg.request.attributes ? cfg.request.attributes : null;
    if (!attrs) return;
    const scenarioKey = `scenario:${String(scenarioId || '').toUpperCase()}`;
    if (scenarioKey.trim()) {
      scenarioAttrByKey.set(scenarioKey, attrs);
    }
    const typeRaw = cfg.request && (cfg.request.typeRef || cfg.request.type);
    const typeKey = canonicalType(typeRaw || '');
    if (typeKey) {
      const mapKey = `type:${typeKey}`;
      if (!scenarioAttrByKey.has(mapKey)) {
        scenarioAttrByKey.set(mapKey, attrs);
      }
    }
  });
}

function resolveAttributesForMeta(meta, type) {
  if (meta && (meta.attributes || (meta.scope && meta.scope.attributes))) {
    return meta.attributes || (meta.scope && meta.scope.attributes) || null;
  }
  const scenarioId = meta && meta.scenario ? String(meta.scenario).toUpperCase() : '';
  if (scenarioId) {
    const fromScenario = scenarioAttrByKey.get(`scenario:${scenarioId}`);
    if (fromScenario) return fromScenario;
    if (scenarioConfigs[scenarioId] && scenarioConfigs[scenarioId].request && scenarioConfigs[scenarioId].request.attributes) {
      return scenarioConfigs[scenarioId].request.attributes;
    }
  }
  const resolvedType = canonicalType(type || meta?.type || '');
  if (resolvedType) {
    const fromType = scenarioAttrByKey.get(`type:${resolvedType}`);
    if (fromType) return fromType;
  }
  return null;
}

function formatFieldDisplay(type, key, payload) {
  const schema = schemaForType(type);
  const labels = schema?.labels || {};
  const formatMap = schema?.format || {};
  const raw = payload ? payload[key] : undefined;
  let value = raw;
  const fmt = formatMap[key];
  if (fmt === 'date') {
    if (typeof raw === 'string') {
      try { value = formatDate(new Date(raw).getTime()); } catch { value = raw; }
    } else if (typeof raw === 'number') {
      value = formatDate(raw);
    }
  } else if (fmt === 'boolean') {
    value = raw ? 'ja' : 'nee';
  } else if (fmt === 'eur') {
    value = formatCurrencyEUR(raw);
  } else if (Array.isArray(raw)) {
    value = raw.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
  } else if (typeof raw === 'object' && raw != null) {
    try { value = JSON.stringify(raw); } catch { value = String(raw); }
  }
  return {
    label: labels[key] || key,
    value: value == null ? '' : String(value),
  };
}

function humanList(items) {
  const list = (items || []).map((v) => String(v || '').trim()).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} en ${list[1]}`;
  return `${list.slice(0, list.length - 1).join(', ')} en ${list[list.length - 1]}`;
}

function buildAttributePlan(card, meta) {
  const type = canonicalType(card?.type || '');
  const schema = schemaForType(type);
  const order = Array.isArray(schema?.order) ? schema.order.slice() : [];
  const payloadKeys = Object.keys(card?.payload || {});
  payloadKeys.forEach((k) => { if (!order.includes(k)) order.push(k); });
  const attrMeta = resolveAttributesForMeta(meta || {}, type) || {};
  const normalize = (key) => String(key || '').trim();
  const required = new Set(Array.isArray(attrMeta.required) ? attrMeta.required.map(normalize).filter(Boolean) : []);
  const optional = new Set(Array.isArray(attrMeta.optional) ? attrMeta.optional.map(normalize).filter(Boolean) : []);
  if (required.size === 0 && optional.size === 0) {
    payloadKeys.forEach((key) => required.add(key));
  } else if (required.size === 0) {
    payloadKeys.forEach((key) => { if (!optional.has(key)) required.add(key); });
  }
  return { type, schema, order, required, optional };
}

function ensureSelectionForCard(share, card, plan) {
  if (!share) return new Set();
  if (!share.fieldSelections) share.fieldSelections = new Map();
  const selectionKey = card && card.id ? card.id : `${share.id || 'share'}-${plan.type || 'generic'}-${plan.order.length}`;
  let selection = share.fieldSelections.get(selectionKey);
  if (!selection) {
    selection = new Set();
    const autoSelectAll = plan.required.size === 0 && plan.optional.size === 0;
    plan.order.forEach((field) => {
      if (!card?.payload || !Object.prototype.hasOwnProperty.call(card.payload, field)) return;
      if (autoSelectAll || plan.required.has(field)) {
        selection.add(field);
      }
    });
    share.fieldSelections.set(selectionKey, selection);
  }
  plan.order.forEach((field) => {
    if (plan.required.has(field) && card?.payload && Object.prototype.hasOwnProperty.call(card.payload, field)) {
      selection.add(field);
    }
  });
  Array.from(selection).forEach((field) => {
    if (!card?.payload || !Object.prototype.hasOwnProperty.call(card.payload, field)) {
      selection.delete(field);
    }
  });
  return selection;
}

function migrateState() {
  try {
    if (!state || !Array.isArray(state.cards)) return;
    state.cards.forEach((c) => {
      if (!c || !c.payload) return;
      // Normalize type values for robustness
      c.type = canonicalType(c.type || '');
      // Keep data-driven; no type-specific transformations
      const toTs = (v) => {
        if (!v) return undefined;
        if (typeof v === 'number') return v;
        const t = Date.parse(v);
        return isNaN(t) ? undefined : t;
      };
      c.issuedAt = toTs(c.issuedAt) || c.issuedAt;
      c.expiresAt = toTs(c.expiresAt) || c.expiresAt;
    });
    saveState(state);
  } catch {}
}

function clearWallet() {
  state = { cards: [] };
  saveState(state);
  try { settings.hideSeedPrompt = false; saveSettings(settings); } catch {}
  renderCards();
}

function seedFromFile(path, setName) {
  loadJson(path).then(async (seed) => {
    const now = Date.now();
    const toTs = (v) => { if (!v) return undefined; if (typeof v === 'number') return v; const t = Date.parse(v); return isNaN(t) ? undefined : t; };
    const list = (() => {
      try {
        if (seed && seed.sets && setName && Array.isArray(seed.sets[String(setName)])) {
          return seed.sets[String(setName)];
        }
        if (seed && seed.sets && Array.isArray(seed.sets.default)) {
          return seed.sets.default;
        }
      } catch {}
      return Array.isArray(seed && seed.cards) ? seed.cards : [];
    })();
    let content = null;
    const mapped = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i] || {};
      if ((c.typeRef || c.type) && c.contentRef) {
        if (!content) { content = await loadJson('../data/card-content.json'); }
        const item = content && content[String(c.contentRef)] || null;
        const t = String(c.typeRef || c.type || (item && item.type) || '').toUpperCase().replace(/[\s-]+/g, '_');
        if (item && t) {
          mapped.push({
            id: `${t}-${now + i}`,
            type: t,
            issuer: item.issuer || '',
            issuedAt: toTs(item.issuedAt),
            expiresAt: toTs(item.expiresAt),
            expanded: false,
            payload: item.payload || {},
          });
        }
        continue;
      }
      if (c && c.type) {
        mapped.push({
          id: c.id || `${c.type}-${now + i}`,
          type: c.type,
          issuer: c.issuer || '',
          issuedAt: toTs(c.issuedAt),
          expiresAt: toTs(c.expiresAt),
          expanded: false,
          payload: c.payload || {},
        });
      }
    }
    if (mapped.length === 0) {
      console.warn('Geen voorbeeldkaarten gevonden in ../data/cards-seed.json');
      return;
    }
    state.cards = [...(state.cards || []), ...mapped];
    try { settings.hideSeedPrompt = true; saveSettings(settings); } catch {}
    saveState(state);
    renderCards();
  });
}

function seedFromTemplates() { return seedFromFile('../data/cards-seed.json', 'pid_inkomen'); }

function renderCards() {
  const list = $('#cardsList');
  if (!list) return;
  list.innerHTML = '';
  if (state.cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bg-cardBg border border-dashed border-gray-300 rounded-xl p-6 text-center';
    const showAdvancedSeeds = settings.advancedSeedOptions !== false;
    if (settings.hideSeedPrompt) {
      empty.innerHTML = `
        <p class="font-inter text-sm text-gray-700 mb-3">De wallet is leeg.</p>
        <p class="font-inter text-xs text-gray-600">Scan een QR om gegevens toe te voegen.</p>`;
    } else {
      empty.innerHTML = `
        <p class="font-inter text-sm text-gray-700 mb-3">De wallet is leeg.</p>
        <p class="font-inter text-xs text-gray-600">De wallet voorzien van gegevens?</p>
        <div class="mt-4 flex flex-col items-center gap-3 w-full">
          <div class="flex flex-wrap items-center justify-center gap-3 w-full">
            <button id="seedPidBtn" class="px-4 py-2 rounded-md text-sm font-inter bg-brandBlue text-white hover:bg-brandBlueHover">Ja, vul met PID</button>
            <button id="skipSeedBtn" class="px-4 py-2 rounded-md text-sm font-inter bg-white border border-gray-300 text-textDark">Nee</button>
          </div>
          ${showAdvancedSeeds ? `<div class="flex flex-wrap items-center justify-center gap-3 w-full">
            <button id="seedPidIncomeBtn" class="px-4 py-2 rounded-md text-sm font-inter bg-brandBlue text-white hover:bg-brandBlueHover">PID + INKOMEN</button>
            <button id="seedPidNvmBtn" class="px-4 py-2 rounded-md text-sm font-inter bg-brandBlue text-white hover:bg-brandBlueHover">PID + NVM LIDMAATSCHAP</button>
          </div>` : ''}
        </div>
        <p class="font-inter text-xs text-gray-600 mt-3">Je kunt ook altijd een QR scannen.</p>`;
    }
    list.appendChild(empty);
    if (!settings.hideSeedPrompt) {
      const pid = empty.querySelector('#seedPidBtn');
      const no = empty.querySelector('#skipSeedBtn');
      const pidInc = showAdvancedSeeds ? empty.querySelector('#seedPidIncomeBtn') : null;
      const pidNvm = showAdvancedSeeds ? empty.querySelector('#seedPidNvmBtn') : null;
      const markAdvanced = () => {
        if (settings.advancedSeedOptions === false) {
          settings.advancedSeedOptions = true;
          saveSettings(settings);
        }
      };
      pid?.addEventListener('click', (e) => { e.currentTarget.disabled = true; markAdvanced(); seedFromFile('../data/cards-seed.json', 'pid'); });
      pidInc?.addEventListener('click', (e) => { e.currentTarget.disabled = true; markAdvanced(); seedFromFile('../data/cards-seed.json', 'pid_inkomen'); });
      pidNvm?.addEventListener('click', (e) => { e.currentTarget.disabled = true; markAdvanced(); seedFromFile('../data/cards-seed.json', 'pid_nvm'); });
      no?.addEventListener('click', () => {
        settings.hideSeedPrompt = true;
        settings.advancedSeedOptions = true;
        saveSettings(settings);
        renderCards();
      });
    }
    return;
  }
  state.cards.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'bg-cardBg rounded-xl p-4 border border-gray-200 flex flex-col gap-3';

    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-4';
    const title = document.createElement('div');
    title.innerHTML = `<div class=\"font-headland text-lg\">${labelForType(c.type)}</div><div class=\"font-inter text-sm text-gray-700\">${c.issuer}</div>`;
    const leftWrap = document.createElement('div');
    leftWrap.className = 'flex items-start gap-3';
    leftWrap.appendChild(title);
    const statusNow = computeStatus(c);
    const badge = document.createElement('span');
    if (statusNow === 'geldig') {
      badge.className = 'font-inter text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800';
    } else {
      badge.className = 'font-inter text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800';
    }
    badge.textContent = statusNow;
    header.appendChild(leftWrap);
    header.appendChild(badge);
    el.appendChild(header);

    const details = document.createElement('div');
    details.className = c.expanded ? 'block' : 'hidden';
    const status = computeStatus(c); const statusCls = status === 'geldig' ? 'text-green-700' : 'text-red-700';
    const metaRows = document.createElement('div');
    metaRows.className = 'mt-1 grid grid-cols-1 gap-1 font-inter text-sm';
    metaRows.innerHTML = `
      <div><strong>Uitgegeven</strong>: ${formatDateTime(c.issuedAt)}</div>
      <div><strong>Verloopt</strong>: ${formatDateTime(c.expiresAt)}</div>
    `;
    details.appendChild(metaRows);
    details.appendChild(renderDetailsFromSchema(c.type, c.payload || {}));
    const actionsRow = document.createElement('div');
    actionsRow.className = 'mt-3 flex items-center gap-2';
    const renewBtn = document.createElement('button');
    renewBtn.className = 'px-3 py-1 rounded-md text-sm font-inter bg-white border border-gray-300 text-textDark hover:bg-brandBlue hover:text-white';
    renewBtn.textContent = 'Vernieuwen';
    renewBtn.addEventListener('click', (e) => { e.stopPropagation(); const now = Date.now(); const oneYear = 365*24*60*60*1000; c.issuedAt = now; c.expiresAt = now + oneYear; saveState(state); renderCards(); });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'px-3 py-1 rounded-md text-sm font-inter bg-white border border-gray-300 text-textDark hover:bg-red-600 hover:text-white';
    removeBtn.textContent = 'Verwijder';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.cards = state.cards.filter((x) => x.id !== c.id);
      if (state.cards.length === 0) { try { settings.hideSeedPrompt = true; saveSettings(settings); } catch {} }
      saveState(state);
      renderCards();
    });
    actionsRow.appendChild(renewBtn);
    actionsRow.appendChild(removeBtn);
    details.appendChild(actionsRow);
    el.appendChild(details);

    el.addEventListener('click', () => { c.expanded = !c.expanded; saveState(state); renderCards(); });

    list.appendChild(el);
  });
}

async function confirmWithPin(pinValue = '123456') {
  return new Promise((resolve) => {
    try {
      const overlay = document.getElementById('pinOverlay');
      const dots = overlay?.querySelectorAll('#pinDots > span');
      const keys = overlay?.querySelectorAll('.pin-key');
      const backBtn = overlay?.querySelector('#pinBack');
      const cancelBtn = overlay?.querySelector('#pinCancel');
      const err = overlay?.querySelector('#pinError');
      const pad = overlay?.querySelector('#pinPadContent') || overlay?.querySelector('#pinPad');
      const checking = overlay?.querySelector('#pinChecking');
      if (!overlay || !dots || !keys || !err) { resolve(true); return; }

      let value = '';
      const PIN = normalizePinValue(pinValue || '123456');
      let isChecking = false;
      const setChecking = (checkingOn) => {
        isChecking = !!checkingOn;
        if (pad) {
          pad.style.opacity = isChecking ? '0.35' : '';
          pad.style.filter = isChecking ? 'blur(1px)' : '';
        }
        if (checking) checking.classList.toggle('hidden', !isChecking);
      };
      const setInteractivity = (enabled) => {
        keys.forEach((k) => { try { k.disabled = !enabled; } catch {} });
        if (backBtn) { try { backBtn.disabled = !enabled; } catch {} }
        if (cancelBtn) {
          try {
            cancelBtn.style.pointerEvents = enabled ? '' : 'none';
            if (enabled) cancelBtn.removeAttribute('aria-disabled');
            else cancelBtn.setAttribute('aria-disabled', 'true');
          } catch {}
        }
      };
      const renderDots = () => {
        dots.forEach((d, i) => {
          d.className = i < value.length
            ? 'w-3 h-3 rounded-full bg-textDark inline-block'
            : 'w-3 h-3 rounded-full border border-textDark/40 inline-block';
        });
      };
      const clearErr = () => { try { err.textContent = ''; err.classList.add('invisible'); err.classList.remove('hidden'); } catch {} };
      const showErr = (m) => { try { err.textContent = m; err.classList.remove('invisible'); } catch {} };
      const showOverlay = () => { try { overlay.style.display = ''; overlay.classList.remove('hidden'); } catch {} };
      const hideOverlay = () => { try { overlay.classList.add('hidden'); overlay.style.display = 'none'; } catch {} };

      const cleanup = () => {
        try { keys.forEach((k) => k.removeEventListener('pointerdown', onKey)); } catch {}
        try { backBtn && backBtn.removeEventListener('click', onBack); } catch {}
        try { cancelBtn && cancelBtn.removeEventListener('click', onCancel); } catch {}
        try { window.removeEventListener('keydown', onKeydown); } catch {}
      };

      const trySubmit = () => {
        if (value.length !== PIN.length) return;
        if (value !== PIN) {
          value = '';
          renderDots();
          showErr('Onjuiste PIN. Probeer opnieuw.');
          return;
        }
        clearErr();
        setChecking(true);
        setInteractivity(false);
        setTimeout(() => {
          cleanup();
          setChecking(false);
          hideOverlay();
          resolve(true);
        }, 2000);
      };

      const onKey = (e) => {
        if (isChecking) return;
        e?.preventDefault?.();
        const t = e.currentTarget;
        if (!(t instanceof Element)) return;
        const d = t.getAttribute('data-digit');
        if (!d) return;
        clearErr();
        if (value.length >= PIN.length) return;
        value += d;
        renderDots();
        if (value.length === PIN.length) trySubmit();
      };
      const onBack = (e) => {
        if (isChecking) return;
        e?.preventDefault?.();
        clearErr();
        value = value.slice(0, -1);
        renderDots();
      };
      const onCancel = (e) => {
        if (isChecking) return;
        e?.preventDefault?.();
        cleanup();
        hideOverlay();
        resolve(false);
      };
      const onKeydown = (e) => {
        if (isChecking) return;
        if (/^[0-9]$/.test(e.key)) {
          if (value.length < PIN.length) {
            value += e.key;
            renderDots();
            if (value.length === PIN.length) trySubmit();
          }
          e.preventDefault();
        } else if (e.key === 'Backspace') {
          value = value.slice(0, -1);
          renderDots();
          e.preventDefault();
        }
      };

      keys.forEach((k) => k.addEventListener('pointerdown', onKey));
      backBtn && backBtn.addEventListener('click', onBack);
      cancelBtn && cancelBtn.addEventListener('click', onCancel);
      window.addEventListener('keydown', onKeydown, { once: false });

      clearErr();
      setChecking(false);
      setInteractivity(true);
      renderDots();
      showOverlay();
    } catch {
      resolve(true);
    }
  });
}

function renderShareView() {
  const info = document.getElementById('shareInfo');
  const details = document.getElementById('shareDetails');
  const choices = document.getElementById('shareChoices');
  const err = document.getElementById('shareError');
  const btn = document.getElementById('shareConfirm');
  const cancel = document.getElementById('shareCancel');
  if (!info || !details || !btn || !err) return;
  // Reset button state and handler each time we render this view
  try { btn.disabled = false; btn.onclick = null; } catch {}
  info.textContent = '';
  details.innerHTML = '';
  if (choices) { choices.innerHTML = ''; choices.classList.add('hidden'); }
  err.textContent = '';
  if (!pendingShare || !Array.isArray(pendingShare.candidates) || pendingShare.candidates.length === 0) {
    info.textContent = 'Geen passende gegevens in de wallet gevonden voor dit verzoek.';
    try { btn.style.display = 'none'; } catch {}
    if (cancel) { cancel.textContent = 'Verder'; cancel.style.display = ''; }
    // Notify portal that nothing was found (once)
    if (pendingShare && !pendingShare._reported) {
      pendingShare._reported = true;
      (async () => {
        try {
          const f = await flow();
          let reqType = (pendingShare.meta?.type || '').toString().toUpperCase().trim();
          if (!reqType) { try { const rt = await f.getType(pendingShare.id); if (rt) reqType = String(rt).toUpperCase().trim(); } catch {} }
          await f.setShared(pendingShare.id, { error: 'not_found', requestedType: reqType, version: 1 });
          await f.setResponse(pendingShare.id, { outcome: 'not_found', requestedType: reqType, version: 1 });
          await f.markCompleted(pendingShare.id);
          try { sessionStorage.setItem('lastAction', 'shared_none'); } catch {}
          try { window.location.hash = '#/done'; } catch {}
        } catch {}
      })();
    }
    return;
  }
  const { meta } = pendingShare;
  const cards = pendingShare.candidates || [];
  let sel = typeof pendingShare.selectedIndex === 'number' ? pendingShare.selectedIndex : 0;
  if (sel < 0 || sel >= cards.length) sel = 0;
  pendingShare.selectedIndex = sel;
  const renderSelected = () => {
    const card = cards[pendingShare.selectedIndex];
    if (!card) return;
    const plan = buildAttributePlan(card, meta || {});
    const selection = ensureSelectionForCard(pendingShare, card, plan);
    pendingShare.selectedFields = selection;
    const payload = card.payload || {};
    const availableKeys = plan.order.filter((key) => Object.prototype.hasOwnProperty.call(payload, key));
    const requiredLabels = Array.from(plan.required).map((key) => {
      const out = formatFieldDisplay(card.type, key, payload);
      return out.label || key;
    }).filter(Boolean);
    info.innerHTML = '';
    const infoWrap = document.createElement('div');
    infoWrap.className = 'flex flex-col gap-1';
    const infoTitle = document.createElement('p');
    infoTitle.className = 'font-inter text-sm text-gray-800';
    infoTitle.textContent = `Selecteer welke gegevens je deelt (${labelForType(card.type)}).`;
    infoWrap.appendChild(infoTitle);
    info.appendChild(infoWrap);
    details.innerHTML = '';
    const missingRequired = Array.from(plan.required).filter((key) => !availableKeys.includes(key));
    const expired = Boolean(pendingShare._expired);
    if (missingRequired.length) {
      const labels = missingRequired.map((key) => formatFieldDisplay(card.type, key, payload).label || key);
      err.textContent = `Deze kaart mist verplichte gegevens: ${humanList(labels)}. Kies een andere kaart.`;
      btn.disabled = true;
    } else if (!expired) {
      err.textContent = '';
      btn.disabled = false;
      try { btn.style.display = ''; } catch {}
    }
    if (expired) {
      err.textContent = 'Het verzoek is verlopen. Vraag een nieuwe QR-code aan.';
      try { btn.disabled = true; btn.style.display = 'none'; } catch {}
      if (cancel) { cancel.textContent = 'Terug'; cancel.style.display = ''; }
    }
    const list = document.createElement('div');
    list.className = 'flex flex-col gap-3';
    const baseRowCls = 'w-full text-left flex items-center justify-between gap-4 rounded-2xl border px-4 py-3 transition-all duration-150';
    const toggleVisual = (span, checked) => {
      span.style.borderColor = 'var(--color-brandBlue, #163563)';
      span.style.backgroundColor = checked ? 'var(--color-brandBlue, #163563)' : '#fff';
      span.style.color = checked ? '#fff' : 'transparent';
      if (expired) span.style.opacity = '0.5';
    };
    availableKeys.forEach((key) => {
      const required = plan.required.has(key);
      const checked = selection.has(key);
      const row = document.createElement('button');
      row.type = 'button';
      let rowCls = baseRowCls;
      rowCls += checked ? ' bg-white border-gray-300' : ' bg-white/70 border-gray-200';
      if (required || expired) {
        rowCls += ' cursor-default';
        if (expired) rowCls += ' opacity-60';
      } else {
        rowCls += ' cursor-pointer hover:border-gray-400 hover:bg-white';
      }
      row.className = rowCls;
      const content = document.createElement('div');
      content.className = 'flex flex-col items-start gap-1';
      const labelRow = document.createElement('div');
      labelRow.className = 'flex items-center gap-2';
      const labelEl = document.createElement('span');
      labelEl.className = 'font-inter text-sm text-gray-900';
      const out = formatFieldDisplay(card.type, key, payload);
      labelEl.textContent = out.label;
      labelRow.appendChild(labelEl);
      if (required) {
        const badge = document.createElement('span');
        badge.className = 'font-inter text-xs uppercase tracking-wide px-2 py-0.5 rounded-full';
        badge.style.backgroundColor = 'rgba(22, 53, 99, 0.12)';
        badge.style.color = 'var(--color-brandBlue, #163563)';
        badge.textContent = 'Verplicht';
        labelRow.appendChild(badge);
      }
      const valueEl = document.createElement('span');
      valueEl.className = 'font-inter text-xs text-gray-700 break-words';
      valueEl.textContent = out.value || 'Niet beschikbaar';
      content.appendChild(labelRow);
      content.appendChild(valueEl);
      const toggle = document.createElement('span');
      toggle.className = 'w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all duration-150 select-none';
      toggle.innerHTML = '<svg viewBox="0 0 16 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M1 5.5 5.5 10 15 1.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
      if (required || expired) {
        toggle.classList.add('cursor-default');
      }
      toggleVisual(toggle, checked);
      row.appendChild(content);
      row.appendChild(toggle);
      if (!required && !expired) {
        row.addEventListener('click', () => {
          if (selection.has(key)) selection.delete(key);
          else selection.add(key);
          renderSelected();
        });
      }
      list.appendChild(row);
    });
    details.appendChild(list);
  };
  if (choices) {
    choices.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-2';
    cards.forEach((c, i) => {
      const row = document.createElement('label');
      row.className = 'flex items-center gap-2 font-inter text-sm bg-white/70 border border-gray-200 rounded-md px-3 py-2 cursor-pointer';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'shareCardSel';
      input.value = String(i);
      input.checked = i === pendingShare.selectedIndex;
      input.addEventListener('change', () => { pendingShare.selectedIndex = i; renderSelected(); });
      const txt = document.createElement('div');
      const yr = (c.payload && (c.payload.nl_bld_bri_year || c.payload.year)) ? ` • ${c.payload.nl_bld_bri_year || c.payload.year}` : '';
      txt.textContent = `${labelForType(c.type)}${yr}`;
      row.appendChild(input);
      row.appendChild(txt);
      wrap.appendChild(row);
    });
    choices.appendChild(wrap);
    if (cards.length > 1) { choices.classList.remove('hidden'); }
  }
  renderSelected();
  try { btn.style.display = ''; } catch {}
  if (cancel) { cancel.textContent = 'Annuleren'; cancel.style.display = ''; }
  btn.onclick = async () => {
    if (pendingShare && pendingShare._expired) {
      // Prevent sharing after expiration
      err.textContent = 'Het verzoek is verlopen. Vraag een nieuwe QR-code aan.';
      btn.disabled = true;
      return;
    }
    btn.disabled = true;
    const pinValue = getConfiguredPinValue();
    const ok = await confirmWithPin(pinValue);
    if (!ok) { btn.disabled = false; return; }
    try {
      const f = await flow();
      const card = cards[pendingShare.selectedIndex];
      const plan = buildAttributePlan(card, meta || {});
      const selection = ensureSelectionForCard(pendingShare, card, plan);
      const selectedKeys = Array.from(selection || []);
      if (!selectedKeys.length) {
        err.textContent = 'Selecteer minstens één attribuut om te delen.';
        btn.disabled = false;
        return;
      }
      const filteredPayload = {};
      selectedKeys.forEach((key) => {
        if (card.payload && Object.prototype.hasOwnProperty.call(card.payload, key)) {
          filteredPayload[key] = card.payload[key];
        }
      });
      await f.setShared(pendingShare.id, { type: card.type, issuer: card.issuer, payload: filteredPayload, version: 1 });
      await f.setResponse(pendingShare.id, {
        outcome: 'ok',
        type: card.type,
        issuer: card.issuer,
        payload: filteredPayload,
        version: 1,
        selectedFields: selectedKeys,
      });
      await f.markCompleted(pendingShare.id);
    } catch {}
    try { sessionStorage.setItem('lastAction', 'shared'); } catch {}
    try { window.location.hash = '#/done'; } catch {}
  };

  // Listen for expiration from the portal/backend and update UI when it happens
  (async () => {
    try {
      const f = await flow();
      if (typeof shareStatusUnsub === 'function') {
        try { shareStatusUnsub(); } catch {}
      }
      shareStatusUnsub = f.onExpired(pendingShare.id, () => {
        if (!pendingShare || pendingShare._expired) return;
        pendingShare._expired = true;
        try { btn.disabled = true; btn.style.display = 'none'; } catch {}
        if (err) err.textContent = 'Het verzoek is verlopen. Vraag een nieuwe QR-code aan.';
        if (cancel) { cancel.textContent = 'Terug'; cancel.style.display = ''; }
        try { renderSelected(); } catch {}
      });
    } catch {}
  })();
}

function showView(name) {
  VIEWS.forEach(v => {
    const s = document.querySelector(`[data-view="${v}"]`);
    if (!s) return;
    if (v === name) { s.classList.remove('hidden'); } else { s.classList.add('hidden'); }
  });
}

function currentRoute() { const h = location.hash.replace(/^#\/?/, '').trim(); return h || 'wallet'; }

let doneTimer = null;
async function onRouteChange() {
  const route = currentRoute();
  console.log('Route changed to:', route);
  const scanView = document.querySelector('[data-view="scan"]');
  if (route !== 'share' && typeof shareStatusUnsub === 'function') {
    try { shareStatusUnsub(); } catch {}
    shareStatusUnsub = null;
  }
  if (route !== 'scan') {
    console.log('Stopping scanner for non-scan route...');
    const scanner = scanView?.querySelector('[data-qrflow="scanner"]');
    if (scanner) {
      const ctrl = scanner._qrflowCtrl;
      if (ctrl && typeof ctrl.stop === 'function') {
        try {
          await ctrl.stop();
          console.log('Scanner stopped successfully.');
        } catch (e) {
          console.error('Failed to stop scanner:', e);
        }
        try {
          await ctrl.clear();
          console.log('Scanner cleared successfully.');
        } catch (e) {
          console.error('Failed to clear scanner:', e);
        }
        delete scanner._qrflowCtrl;
      } else {
        console.warn('No scanner controller found, attempting manual cleanup...');
      }
      const video = scanView?.querySelector('video');
      if (video && video.srcObject) {
        console.log('Manually stopping video stream...');
        video.srcObject.getTracks().forEach(track => {
          try {
            track.stop();
            console.log('Video track stopped:', track.kind);
          } catch (e) {
            console.error('Failed to stop track:', e);
          }
        });
        video.srcObject = null;
        video.pause();
      }
      const container = scanView?.querySelector('#reader');
      if (container) {
        container.innerHTML = '';
        console.log('Scanner container cleared.');
      }
    }
  }
  showView(route); try { const ov = document.getElementById('pinOverlay'); if (ov) { ov.classList.add('hidden'); ov.style.display='none'; } } catch {}
  if (doneTimer) {
    try {
      clearTimeout(doneTimer);
    } catch {}
    doneTimer = null;
  }
  if (route === 'done') {
    try {
      const el = document.getElementById('doneTitle');
      const icon = document.getElementById('doneIcon');
      const last = sessionStorage.getItem('lastAction') || '';
      if (el) {
        if (last === 'shared') el.textContent = 'Gegevens gedeeld';
        else if (last === 'shared_none') el.textContent = 'Niet gedeeld';
        else el.textContent = 'Gegevens toegevoegd';
      }
      if (icon) {
        const success = last !== 'shared_none';
        icon.style.display = success ? '' : 'none';
      }
    } catch {}
    doneTimer = setTimeout(() => {
      try {
        window.location.replace('#/wallet');
      } catch {
        window.location.hash = '#/wallet';
      }
    }, 1000);
  }
  if (route === 'share') {
    renderShareView();
  }
  if (route === 'scan') {
    // Reset manual input and any previous error/session state
    try {
      const input = document.getElementById('manualCode');
      if (input) input.value = '';
    } catch {}
    try {
      const err = document.getElementById('scanError');
      if (err) err.textContent = '';
    } catch {}
    
    try { const ov = document.getElementById('scanOverlay'); if (ov) ov.classList.add('hidden'); } catch {}
    try { const cont = document.getElementById('reader'); if (cont) cont.style.opacity = ''; } catch {}
    try { sessionStorage.removeItem('lastAction'); } catch {}
    try {
      const scanner = scanView?.querySelector('[data-qrflow="scanner"]');
      if (scanner) {
        delete scanner.dataset.sessionId;
        if (scanner._qrflowCtrl) {
          try { await scanner._qrflowCtrl.stop?.(); } catch {}
          try { await scanner._qrflowCtrl.clear?.(); } catch {}
          delete scanner._qrflowCtrl;
        }
        const container = scanView?.querySelector('#reader');
        if (container) container.innerHTML = '';
      }
    } catch {}
  }
}

function attachScanHandlers() {
  const scanners = Array.from(document.querySelectorAll('[data-qrflow="scanner"]'));
  if (scanners.length === 0) return;
  scanners.forEach((scanner) => {
    const container = document.getElementById('reader');
    const overlayEl = document.getElementById('scanOverlay');
    scanner.addEventListener('qrflow:scanned', async (e) => {
      const id = (scanner.getAttribute('data-session-id') || (e.detail && e.detail.id) || '').toString();
      if (!id) return;
      
      try { if (overlayEl) overlayEl.classList.remove('hidden'); } catch {}
      try { if (container) container.style.opacity = '0.5'; } catch {}
      try {
        const f = await flow();
        // Fast path: check root intent
        let intent = '';
        try { intent = String(await f.getIntent(id) || '').toLowerCase(); } catch {}
        // Fallback to meta detection if needed
        let meta = null;
        const ensureMeta = async () => {
          let m = await f.getRequest(id);
          if (!m) m = await f.getOffer(id);
          return m;
        };
        // Always attempt to have meta ready for both flows (especially add-card)
        meta = await ensureMeta();
        if (!meta) {
          for (let i = 0; i < 10 && !meta; i++) {
            await new Promise(r => setTimeout(r, 200));
            try { meta = await ensureMeta(); } catch {}
          }
        }
        if (meta) pendingMeta.set(id, meta);
        if (!intent) {
          intent = (meta && (meta.intent || (meta.payload && meta.payload.intent))) ? String(meta.intent || meta.payload.intent).toLowerCase() : '';
        }
        if (intent === 'use_card') {
          let reqType = '';
          try {
            const m = pendingMeta.get(id) || (await f.getRequest(id)) || null;
            reqType = (m && m.type) ? String(m.type).toUpperCase().trim() : '';
            if (!reqType) {
              const rootType = await f.getType(id);
              if (rootType) reqType = String(rootType).toUpperCase().trim();
            }
            if (!meta) meta = m;
          } catch {}
          const normalize = (s) => (s == null ? '' : String(s).toUpperCase().trim());
          let candidates = state.cards.filter(c => normalize(c.type) === reqType);
          if (reqType === '' && candidates.length === 0 && state.cards.length === 1) {
            candidates = [state.cards[0]];
          }
          pendingShare = { id, meta, candidates, selectedIndex: 0, fieldSelections: new Map() };
          try { window.location.hash = '#/share'; } catch {}
          renderShareView();
        }
      } catch {}
    });
    scanner.addEventListener('qrflow:completed', async (e) => {
      
      try { if (overlayEl) overlayEl.classList.add('hidden'); } catch {}
      try { if (container) container.style.opacity = ''; } catch {}
    });
    scanner.addEventListener('qrflow:error', async (e) => {
      
      try { if (overlayEl) overlayEl.classList.add('hidden'); } catch {}
      try { if (container) container.style.opacity = ''; } catch {}
    });
    scanner.addEventListener('qrflow:completed', async (e) => {
      const id = (scanner.getAttribute('data-session-id') || (e.detail && e.detail.id) || '').toString();
      if (!id) return;
      const f = await flow();
      // Check request first to see if this was a 'use_card' flow; if so, don't add a card.
      try {
        let intentReq = '';
        try { intentReq = String(await f.getIntent(id) || '').toLowerCase(); } catch {}
        if (!intentReq) {
          const req = await f.getRequest(id);
          intentReq = (req && req.intent) ? String(req.intent).toLowerCase() : '';
        }
        if (intentReq === 'use_card') return;
      } catch {}

      // Otherwise treat as add-card flow. Prefer the latest offer from DB.
      // Be robust: retry briefly to avoid race conditions on first scan.
      let m = null;
      const tryFetchMeta = async () => {
        let off = null, req = null;
        try { off = await f.getOffer(id); } catch {}
        if (!off) { try { req = await f.getRequest(id); } catch {} }
        return off || req || pendingMeta.get(id) || null;
      };
      m = await tryFetchMeta();
      if (!m) {
        for (let i = 0; i < 12 && !m; i++) { // ~12*150ms = 1.8s max
          await new Promise(r => setTimeout(r, 150));
          try { m = await tryFetchMeta(); } catch {}
        }
      }
      if (!m) return; // nothing meaningful to add
      const type = (m && m.type) ? String(m.type).toUpperCase() : (Object.keys(uiSchema || {})[0] || 'GENERIC');
      const issuer = (m && m.issuer) || 'Onbekend';
      const payload = (m && m.payload) || {};
      addCardFromSession(id, { type, issuer, payload });
      try { sessionStorage.setItem('lastAction', 'added'); } catch {}
    });
  });
}

window.addEventListener('DOMContentLoaded', () => {
loadJson('../data/card-types.json').then((s) => { uiSchema = s || {}; renderCards(); });
loadJson('../data/use-scenarios.json').then((s) => { setScenarioAttributes(s || {}); }).catch(() => {});
  migrateState();
  renderCards();
  attachScanHandlers();
  window.addEventListener('hashchange', () => { onRouteChange(); });
  onRouteChange();

  const title = document.getElementById('appTitle');
  if (title) {
    let clicks = 0; let timer = null;
    title.addEventListener('click', () => {
      clicks++;
      if (!timer) {
        timer = setTimeout(() => { clicks = 0; timer = null; }, 800);
      }
      if (clicks >= 3) {
        clicks = 0;
        clearTimeout(timer);
        timer = null;
        clearWallet();
        settings.advancedSeedOptions = true;
        settings.hideSeedPrompt = false;
        saveSettings(settings);
        renderCards();
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
      }
    });
  }

  try {
    const hash = location.hash || '';
    if (/clear=1/i.test(hash)) { clearWallet(); location.hash = '#/wallet'; }
  } catch {}
});
function canonicalType(t) {
  let s = (t == null ? '' : String(t)).trim().toUpperCase();
  // Normalize separators (spaces, hyphens) to underscore for schema matching
  s = s.replace(/[\s-]+/g, '_');
  return s;
}

function labelForType(t) {
  const s = canonicalType(t);
  try {
    const schema = uiSchema && (uiSchema[s] || uiSchema[String(s).replace(/_/g, ' ')]);
    if (schema && schema.title) return String(schema.title);
  } catch {}
  try { return (t == null ? '' : String(t)).trim().toUpperCase() || s; } catch { return s; }
}
