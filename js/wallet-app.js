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
const inboxStorageKey = 'walletInboxSessions';
function loadInboxSessions() {
  try {
    const raw = localStorage.getItem(inboxStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const id = item && item.id != null ? String(item.id).trim() : '';
        if (!id) return null;
        return {
          id,
          intent: (item.intent || '').toString(),
          type: (item.type || '').toString(),
          source: (item.source || 'deeplink').toString(),
          title: (item.title || '').toString(),
          scenarioId: (item.scenarioId || '').toString(),
          issuer: (item.issuer || '').toString(),
          addedAt: Number(item.addedAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now(),
          completedAt: Number(item.completedAt) || null,
          expiredAt: Number(item.expiredAt) || null,
          unread: item.unread === true || item.unread === undefined,
          statusInfo: item.statusInfo || null,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
function saveInboxSessions(list) {
  try {
    localStorage.setItem(inboxStorageKey, JSON.stringify(Array.isArray(list) ? list : []));
  } catch {}
}
let inboxSessions = loadInboxSessions();
let inboxNoticeTimer = null;
const inboxFetchInFlight = new Map();
let inboxPollTimer = null;
const pendingMeta = new Map();
let uiSchema = {};
let scenarioConfigs = {};
const scenarioAttrByKey = new Map();
let pendingShare = null; // { id, meta, candidates: Card[], selectedIndex: number }
let shareStatusUnsub = null; // unsubscribe for expired status listener
let inboxDrawerOpen = false;
let inboxDrawerTimer = null;
let inboxDrawerKeyHandler = null;
let bodyOverflowBeforeDrawer = '';
const finalStatusCodes = new Set(['added', 'shared', 'not_found', 'expired']);

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
async function ensureSessionMeta(id, { preferRequest = true, retries = 10, delay = 150, client = null } = {}) {
  const sessionId = (id == null ? '' : String(id)).trim();
  if (!sessionId) return null;
  const f = client || await flow();
  const fetchOnce = async () => {
    if (preferRequest) {
      try {
        const req = await f.getRequest(sessionId);
        if (req) return req;
      } catch {}
      try {
        const offer = await f.getOffer(sessionId);
        if (offer) return offer;
      } catch {}
    } else {
      try {
        const offer = await f.getOffer(sessionId);
        if (offer) return offer;
      } catch {}
      try {
        const req = await f.getRequest(sessionId);
        if (req) return req;
      } catch {}
    }
    return pendingMeta.get(sessionId) || null;
  };
  let meta = await fetchOnce();
  let attempts = 0;
  while (!meta && attempts < retries) {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    meta = await fetchOnce();
  }
  if (meta) pendingMeta.set(sessionId, meta);
  return meta;
}
async function launchShareFlow(id, meta, { client = null } = {}) {
  const sessionId = (id == null ? '' : String(id)).trim();
  if (!sessionId) return false;
  const f = client || await flow();
  let shareMeta = meta || pendingMeta.get(sessionId) || null;
  if (!shareMeta) {
    shareMeta = await ensureSessionMeta(sessionId, { preferRequest: true, client: f });
  } else {
    pendingMeta.set(sessionId, shareMeta);
  }
  if (!shareMeta) return false;
  const normalize = (s) => canonicalType(s || '');
  let reqType = normalize(shareMeta.type || '');
  if (!reqType) {
    try {
      const rootType = await f.getType(sessionId);
      reqType = normalize(rootType || '');
    } catch {}
  }
  let candidates = state.cards.filter((card) => normalize(card.type) === reqType);
  if (!reqType && candidates.length === 0 && state.cards.length === 1) {
    candidates = [state.cards[0]];
  }
  pendingShare = { id: sessionId, meta: shareMeta, candidates, selectedIndex: 0, fieldSelections: new Map() };
  try { window.location.hash = '#/share'; } catch {}
  renderShareView();
  return true;
}
async function addCardFromOfferSession(id, meta, { client = null } = {}) {
  const sessionId = (id == null ? '' : String(id)).trim();
  if (!sessionId) return false;
  const f = client || await flow();
  let offerMeta = meta || pendingMeta.get(sessionId) || null;
  if (!offerMeta) {
    offerMeta = await ensureSessionMeta(sessionId, { preferRequest: false, client: f, retries: 12 });
  }
  if (!offerMeta) return false;
  pendingMeta.set(sessionId, offerMeta);
  const type = canonicalType(offerMeta.type || (Object.keys(uiSchema || {})[0] || 'GENERIC'));
  const issuer = offerMeta.issuer || 'Onbekend';
  const payload = offerMeta.payload || {};
  addCardFromSession(sessionId, { type, issuer, payload });
  try { await f.markCompleted(sessionId); } catch {}
  return true;
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
function formatRelativeTime(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';
  const diff = Date.now() - value;
  if (!Number.isFinite(diff)) return '';
  if (diff < 45 * 1000) return 'zojuist';
  if (diff < 90 * 1000) return '1 min geleden';
  if (diff < 60 * 60 * 1000) return `${Math.round(diff / 60000)} min geleden`;
  if (diff < 2 * 60 * 60 * 1000) return '1 uur geleden';
  if (diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} uur geleden`;
  return formatDateTime(value);
}
function statusBadgeClass(code) {
  switch (code) {
    case 'shared':
    case 'added':
      return 'bg-green-100 text-green-800';
    case 'not_found':
      return 'bg-amber-100 text-amber-800';
    case 'expired':
      return 'bg-gray-200 text-gray-600';
    case 'scanned':
      return 'bg-indigo-100 text-indigo-800';
    default:
      return 'bg-blue-50 text-brandBlue';
  }
}
function deriveInboxStatus({ intent, status = {}, response = null, expiresAt = null } = {}) {
  const lowerIntent = (intent || '').toString().toLowerCase();
  const completedAt = Number(status && status.completedAt);
  const scannedAt = Number(status && status.scannedAt);
  const expiredAt = Number((status && status.expiredAt) || expiresAt);
  const outcome = response && typeof response === 'object' ? (response.outcome || '') : '';
  const now = Date.now();
  if (expiredAt && expiredAt <= now) {
    return { code: 'expired', label: 'Verlopen', description: 'Verzoek verlopen; vraag een nieuwe QR-code aan.' };
  }
  if (outcome === 'not_found') {
    return { code: 'not_found', label: 'Niet gedeeld', description: 'Geen gegevens gedeeld; de sessiecode werkt niet meer.' };
  }
  if (outcome === 'ok' || (completedAt && completedAt > 0)) {
    return lowerIntent === 'use_card'
      ? { code: 'shared', label: 'Gedeeld', description: 'Verzoek verwerkt; de sessiecode is nu ongeldig.' }
      : { code: 'added', label: 'Toegevoegd', description: 'Verzoek gebruikt; de sessiecode werkt niet meer.' };
  }
  if (scannedAt && !completedAt) {
    return lowerIntent === 'use_card'
      ? { code: 'scanned', label: 'Bezig met delen' }
      : { code: 'scanned', label: 'Bezig met toevoegen' };
  }
  return lowerIntent === 'use_card'
    ? { code: 'pending-share', label: 'Verzoek wacht op jou' }
    : { code: 'pending-offer', label: 'Data staat klaar' };
}
function pruneInboxSessions({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - Math.max(0, Number(ttlMs) || 0);
  const before = inboxSessions.length;
  inboxSessions = inboxSessions.filter((entry) => {
    const lastTs = entry.completedAt || entry.updatedAt || entry.addedAt;
    return !lastTs || lastTs >= cutoff;
  });
  if (inboxSessions.length !== before) {
    saveInboxSessions(inboxSessions);
  }
}
function findInboxEntry(id) {
  const key = (id == null ? '' : String(id)).trim();
  if (!key) return null;
  return inboxSessions.find((entry) => entry.id === key) || null;
}
function sourceLabel(source) {
  const key = (source || '').toString().toLowerCase();
  if (!key) return '';
  if (key === 'push') return 'via push';
  if (key === 'deeplink') return 'via link';
  if (key === 'manual') return 'handmatig';
  return `via ${key}`;
}
function upsertInboxEntry(id, data = {}) {
  const normalizedId = (id == null ? '' : String(id)).trim();
  if (!normalizedId) return null;
  let entry = findInboxEntry(normalizedId);
  const now = Date.now();
  if (!entry) {
    entry = {
      id: normalizedId,
      intent: (data.intent || '').toString(),
      type: (data.type || '').toString(),
      source: (data.source || 'deeplink').toString(),
      title: (data.title || '').toString(),
      scenarioId: (data.scenarioId || '').toString(),
      issuer: (data.issuer || '').toString(),
      addedAt: now,
      updatedAt: now,
      completedAt: null,
      expiredAt: null,
      unread: data.unread !== false,
      statusInfo: data.statusInfo || null,
    };
    inboxSessions.unshift(entry);
    if (inboxSessions.length > 12) {
      inboxSessions = inboxSessions.slice(0, 12);
    }
  } else {
    const currentIndex = inboxSessions.findIndex((item) => item.id === entry.id);
    if (data.intent != null) entry.intent = data.intent;
    if (data.type != null) entry.type = data.type;
    if (data.source != null) entry.source = data.source;
    if (data.title != null) entry.title = data.title;
    if (data.scenarioId != null) entry.scenarioId = data.scenarioId;
    if (data.issuer != null) entry.issuer = data.issuer;
    if (data.statusInfo) entry.statusInfo = data.statusInfo;
    if (data.completedAt != null) entry.completedAt = data.completedAt;
    if (data.expiredAt != null) entry.expiredAt = data.expiredAt;
    if (data.unread === false) entry.unread = false;
    if (data.unread === true) entry.unread = true;
    entry.updatedAt = now;
    if (currentIndex > 0) {
      inboxSessions.splice(currentIndex, 1);
      inboxSessions.unshift(entry);
    }
  }
  saveInboxSessions(inboxSessions);
  renderInbox();
  startInboxPolling();
  return entry;
}
function removeInboxEntry(id) {
  const normalizedId = (id == null ? '' : String(id)).trim();
  if (!normalizedId) return;
  const before = inboxSessions.length;
  inboxSessions = inboxSessions.filter((entry) => entry.id !== normalizedId);
  if (before !== inboxSessions.length) {
    saveInboxSessions(inboxSessions);
    renderInbox();
    startInboxPolling();
  }
}
function markInboxEntryRead(id) {
  const entry = findInboxEntry(id);
  if (!entry) return;
  if (!entry.unread) return;
  entry.unread = false;
  entry.updatedAt = Date.now();
  saveInboxSessions(inboxSessions);
  renderInbox();
}
function renderInbox() {
  if (typeof document === 'undefined') return;
  const list = document.getElementById('inboxList');
  const badge = document.getElementById('inboxBadge');
  const subtitle = document.getElementById('inboxSubtitle');
  const toggleBadge = document.getElementById('inboxToggleBadge');
  if (!list) return;
  const count = inboxSessions.length;
  if (toggleBadge) {
    if (count > 0) {
      toggleBadge.textContent = count;
      toggleBadge.classList.remove('hidden');
    } else {
      toggleBadge.classList.add('hidden');
    }
  }
  if (!count) {
    list.innerHTML = '<div class="font-inter text-sm text-gray-600">Geen openstaande verzoeken.</div>';
    if (badge) badge.classList.add('hidden');
    if (subtitle) subtitle.textContent = 'Openstaande sessies verschijnen hier.';
    return;
  }
  if (subtitle) subtitle.textContent = 'Open verzoeken en recente statusupdates';
  list.innerHTML = '';
  if (badge) {
    badge.classList.remove('hidden');
    badge.textContent = count === 1 ? '1 verzoek' : `${count} verzoeken`;
  }
  const frag = document.createDocumentFragment();
  inboxSessions.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'bg-white border border-gray-200 rounded-2xl p-4 flex flex-col gap-3 shadow-sm';
    card.dataset.sessionId = entry.id;
    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-3';
    const headCopy = document.createElement('div');
    headCopy.className = 'flex flex-col gap-1';
    const title = document.createElement('div');
    title.className = 'font-headland text-base';
    title.textContent = entry.title || labelForType(entry.type) || 'Verzoek';
    const meta = document.createElement('div');
    meta.className = 'font-inter text-xs text-gray-600';
    const parts = [];
    if (entry.intent) parts.push(entry.intent === 'use_card' ? 'Delen' : 'Toevoegen');
    if (entry.type) parts.push(labelForType(entry.type));
    const src = sourceLabel(entry.source);
    if (src) parts.push(src);
    if (entry.updatedAt) parts.push(formatRelativeTime(entry.updatedAt));
    meta.textContent = parts.filter(Boolean).join(' • ');
    headCopy.appendChild(title);
    headCopy.appendChild(meta);
    header.appendChild(headCopy);
    const badgeEl = document.createElement('span');
    const statusInfo = entry.statusInfo || deriveInboxStatus({ intent: entry.intent });
    badgeEl.className = `font-inter text-xs px-2 py-0.5 rounded-full ${statusBadgeClass(statusInfo.code)}`;
    badgeEl.textContent = statusInfo.label || 'Status onbekend';
    header.appendChild(badgeEl);
    card.appendChild(header);
    if (statusInfo.description) {
      const desc = document.createElement('p');
      desc.className = 'font-inter text-xs text-gray-600';
      desc.textContent = statusInfo.description;
      card.appendChild(desc);
    }
    if (entry.unread) {
      const unread = document.createElement('span');
      unread.className = 'font-inter text-xs text-brandBlue';
      unread.textContent = 'Nieuw verzoek';
      card.appendChild(unread);
    }
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    const isFinal = statusInfo && finalStatusCodes.has(statusInfo.code);
    openBtn.className = isFinal
      ? 'px-4 py-2 rounded-md text-sm font-inter bg-white border border-gray-300 text-brandBlue hover:bg-gray-50 transition'
      : 'px-4 py-2 rounded-md text-sm font-inter bg-brandBlue text-white hover:bg-brandBlueHover transition';
    openBtn.textContent = isFinal ? 'Details' : (entry.intent === 'use_card' ? 'Bekijk verzoek' : 'Openen');
    if (isFinal) openBtn.setAttribute('data-finalized', 'true'); else openBtn.removeAttribute('data-finalized');
    openBtn.setAttribute('data-inbox-action', 'open');
    openBtn.setAttribute('data-session-id', entry.id);
    actions.appendChild(openBtn);
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'px-4 py-2 rounded-md text-sm font-inter bg-white border border-gray-300 text-textDark hover:bg-gray-50 transition';
    dismissBtn.textContent = 'Verwijder';
    dismissBtn.setAttribute('data-inbox-action', 'dismiss');
    dismissBtn.setAttribute('data-session-id', entry.id);
    actions.appendChild(dismissBtn);
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'px-3 py-2 rounded-md text-xs font-inter text-brandBlue underline';
    refreshBtn.textContent = 'Vernieuwen';
    refreshBtn.setAttribute('data-inbox-action', 'refresh');
    refreshBtn.setAttribute('data-session-id', entry.id);
    actions.appendChild(refreshBtn);
    card.appendChild(actions);
    frag.appendChild(card);
  });
  list.appendChild(frag);
}
let toastTimer = null;
function showFloatingToast(message) {
  let toast = document.getElementById('walletToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'walletToast';
    toast.className = 'wallet-toast px-4 py-2 rounded-full text-white font-inter text-sm shadow-lg z-50 hidden';
    Object.assign(toast.style, {
      position: 'fixed',
      left: '50%',
      bottom: '1.5rem',
      transform: 'translateX(-50%)',
      backgroundColor: 'var(--color-brandBlue, #163563)',
      zIndex: 9999,
      transition: 'opacity 0.25s ease',
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toastTimer = setTimeout(() => { toast.classList.add('hidden'); }, 300);
  }, 3000);
}
function showInboxNotice(message) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('inboxNotice');
  if (el) {
    el.textContent = message;
    if (inboxDrawerOpen) {
      el.classList.remove('hidden');
      if (inboxNoticeTimer) clearTimeout(inboxNoticeTimer);
      inboxNoticeTimer = setTimeout(() => { el.classList.add('hidden'); }, 4000);
    } else {
      el.classList.add('hidden');
    }
  }
  if (!inboxDrawerOpen) {
    showFloatingToast(message);
  }
}
async function refreshInboxEntry(id, { silent = false } = {}) {
  const normalizedId = (id == null ? '' : String(id)).trim();
  if (!normalizedId) return null;
  if (inboxFetchInFlight.has(normalizedId)) {
    return inboxFetchInFlight.get(normalizedId);
  }
  const promise = (async () => {
    const entry = findInboxEntry(normalizedId);
    if (!entry) return null;
    const f = await flow();
    const [intentRaw, request, offer, shared, status, expiresAt] = await Promise.all([
      f.getIntent(normalizedId).catch(() => ''),
      f.getRequest(normalizedId).catch(() => null),
      f.getOffer(normalizedId).catch(() => null),
      f.getShared(normalizedId).catch(() => null),
      f.getStatus(normalizedId).catch(() => ({})),
      f.getExpiresAt(normalizedId).catch(() => null),
    ]);
    const metaSource = request || offer || shared || entry.meta || null;
    let intent = (intentRaw || '').toString().toLowerCase();
    if (!intent && metaSource && metaSource.intent) {
      intent = String(metaSource.intent).toLowerCase();
    }
    entry.intent = intent || entry.intent || '';
    if (metaSource && metaSource.type) entry.type = metaSource.type;
    if (metaSource && metaSource.issuer) entry.issuer = metaSource.issuer;
    if (request && request.scenario) entry.scenarioId = String(request.scenario).toUpperCase();
    const scenarioCfg = entry.scenarioId ? scenarioConfigs[entry.scenarioId] : null;
    if (scenarioCfg && scenarioCfg.title) {
      entry.title = scenarioCfg.title;
    } else if (!entry.title && entry.type) {
      entry.title = labelForType(entry.type);
    }
    entry.updatedAt = Date.now();
    const statusInfo = deriveInboxStatus({
      intent: entry.intent,
      status: status || {},
      response: shared,
      expiresAt,
    });
    entry.statusInfo = statusInfo;
    if (status && status.completedAt) entry.completedAt = Number(status.completedAt) || entry.completedAt;
    if (status && status.expiredAt) entry.expiredAt = Number(status.expiredAt) || entry.expiredAt;
    if (expiresAt && !entry.expiredAt) entry.expiredAt = Number(expiresAt) || entry.expiredAt;
    saveInboxSessions(inboxSessions);
    if (!silent) renderInbox();
    return entry;
  })().finally(() => inboxFetchInFlight.delete(normalizedId));
  inboxFetchInFlight.set(normalizedId, promise);
  return promise;
}
function startInboxPolling() {
  if (inboxPollTimer) {
    clearInterval(inboxPollTimer);
    inboxPollTimer = null;
  }
  if (!inboxSessions.length) return;
  inboxPollTimer = setInterval(() => {
    inboxSessions.forEach((entry) => {
      refreshInboxEntry(entry.id, { silent: true }).catch(() => {});
    });
  }, 15000);
}
function openInboxDrawer() {
  if (inboxDrawerOpen) return;
  const section = document.getElementById('inboxSection');
  const panel = section?.querySelector('[data-inbox-panel]');
  if (!section || !panel) return;
  section.classList.remove('hidden');
  requestAnimationFrame(() => {
    panel.classList.remove('translate-x-full');
    panel.classList.add('translate-x-0');
  });
  bodyOverflowBeforeDrawer = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  inboxDrawerOpen = true;
  inboxDrawerKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeInboxDrawer();
    }
  };
  window.addEventListener('keydown', inboxDrawerKeyHandler);
}
function closeInboxDrawer({ immediate = false } = {}) {
  if (!inboxDrawerOpen) return;
  const section = document.getElementById('inboxSection');
  const panel = section?.querySelector('[data-inbox-panel]');
  if (!section || !panel) return;
  panel.classList.add('translate-x-full');
  panel.classList.remove('translate-x-0');
  const finalize = () => {
    section.classList.add('hidden');
    inboxDrawerOpen = false;
    document.body.style.overflow = bodyOverflowBeforeDrawer || '';
    if (inboxDrawerKeyHandler) {
      window.removeEventListener('keydown', inboxDrawerKeyHandler);
      inboxDrawerKeyHandler = null;
    }
  };
  if (immediate) {
    finalize();
    return;
  }
  if (inboxDrawerTimer) clearTimeout(inboxDrawerTimer);
  inboxDrawerTimer = setTimeout(finalize, 200);
}
function toggleInboxDrawer() {
  if (inboxDrawerOpen) closeInboxDrawer();
  else openInboxDrawer();
}
const INBOX_PARAM_KEYS = ['session', 'code', 'qr', 'id'];
function extractSessionIdFromParams(params) {
  if (!params) return '';
  for (const key of INBOX_PARAM_KEYS) {
    const val = params.get(key);
    if (val) {
      const normalized = String(val).trim();
      if (normalized) return normalized;
    }
  }
  return '';
}
function scrubSessionParamsFromUrl(keys = INBOX_PARAM_KEYS) {
  if (typeof window === 'undefined' || !window.history || typeof window.history.replaceState !== 'function') return;
  try {
    const current = new URL(window.location.href);
    let searchChanged = false;
    keys.forEach((key) => {
      if (current.searchParams.has(key)) {
        current.searchParams.delete(key);
        searchChanged = true;
      }
    });
    ['intent', 'source'].forEach((key) => {
      if (current.searchParams.has(key)) {
        current.searchParams.delete(key);
        searchChanged = true;
      }
    });
    let hashChanged = false;
    let nextHash = current.hash || '';
    if (nextHash.includes('?')) {
      const [hashPath, hashQuery] = nextHash.split('?');
      const params = new URLSearchParams(hashQuery);
      keys.forEach((key) => {
        if (params.has(key)) {
          params.delete(key);
          hashChanged = true;
        }
      });
      ['intent', 'source'].forEach((key) => {
        if (params.has(key)) {
          params.delete(key);
          hashChanged = true;
        }
      });
      nextHash = params.toString() ? `${hashPath}?${params.toString()}` : hashPath;
    }
    if (searchChanged || hashChanged) {
      const searchPart = current.searchParams.toString();
      const nextPath = `${current.pathname}${searchPart ? `?${searchPart}` : ''}${nextHash}`;
      window.history.replaceState({}, document.title, nextPath);
    }
  } catch {}
}
function captureSessionFromUrl() {
  if (typeof window === 'undefined') return null;
  let sessionId = '';
  let intent = '';
  let source = '';
  try {
    const current = new URL(window.location.href);
    sessionId = extractSessionIdFromParams(current.searchParams);
    intent = current.searchParams.get('intent') || '';
    source = current.searchParams.get('source') || '';
  } catch {}
  if (!sessionId) {
    const hash = window.location.hash || '';
    if (hash.includes('?')) {
      const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
      sessionId = extractSessionIdFromParams(params);
      if (!intent) intent = params.get('intent') || '';
      if (!source) source = params.get('source') || '';
    }
  }
  if (!sessionId) return null;
  const existed = Boolean(findInboxEntry(sessionId));
  upsertInboxEntry(sessionId, {
    intent: intent ? intent.toLowerCase() : '',
    source: (source || 'deeplink').toLowerCase(),
    unread: true,
  });
  refreshInboxEntry(sessionId).catch(() => {});
  scrubSessionParamsFromUrl();
  if (!existed) {
    showInboxNotice('Nieuw verzoek ontvangen');
  }
  return sessionId;
}
async function openInboxSession(sessionId) {
  closeInboxDrawer();
  await refreshInboxEntry(sessionId, { silent: true }).catch(() => {});
  const entry = findInboxEntry(sessionId);
  if (!entry) return;
  markInboxEntryRead(sessionId);
  const statusInfo = entry.statusInfo || deriveInboxStatus({ intent: entry.intent });
  if (statusInfo && finalStatusCodes.has(statusInfo.code)) {
    await showRequestInfoOverlay({
      title: `${titleForEntry(entry)} verwerkt`,
      body: statusInfo.description || 'Dit verzoek is al gebruikt. De sessiecode is niet meer geldig.',
      confirmLabel: 'Sluiten',
      allowCancel: false,
    });
    return;
  }
  const friendlyTitle = titleForEntry(entry);
  try {
    const f = await flow();
    try { await f.markScanned(sessionId); } catch {}
    const intent = (entry.intent || '').toLowerCase();
    if (intent === 'use_card') {
      const success = await launchShareFlow(sessionId, pendingMeta.get(sessionId), { client: f });
      if (!success) {
        showInboxNotice('Geen gegevens gevonden voor dit verzoek');
      } else {
        showInboxNotice('Verzoek geopend');
      }
    } else {
      const proceed = await showRequestInfoOverlay({
        title: `Voeg ${friendlyTitle} toe`,
        body: 'Je staat op het punt om gegevens vanuit het portaal toe te voegen aan je wallet. Ga alleen verder als je deze bron vertrouwt.',
        confirmLabel: 'PIN invoeren',
        cancelLabel: 'Annuleren',
        allowCancel: true,
      });
      if (!proceed) {
        showInboxNotice('Actie geannuleerd');
        return;
      }
      const pinValue = getConfiguredPinValue();
      const ok = await confirmWithPin(pinValue);
      if (!ok) {
        showInboxNotice('Actie geannuleerd');
        return;
      }
      const success = await addCardFromOfferSession(sessionId, pendingMeta.get(sessionId), { client: f });
      if (success) {
        try { sessionStorage.setItem('lastAction', 'added'); } catch {}
        try { window.location.hash = '#/done'; } catch {}
        showInboxNotice('Gegevens verwerkt; sessiecode is nu ongeldig.');
      } else {
        showInboxNotice('Kon gegevens niet openen');
      }
    }
    refreshInboxEntry(sessionId, { silent: true }).catch(() => {});
  } catch {
    showInboxNotice('Verzoek openen mislukt');
  }
}

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
function showRequestInfoOverlay({ title, body, confirmLabel = 'OK', cancelLabel = 'Annuleren', allowCancel = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('requestInfoOverlay');
    const titleEl = document.getElementById('requestInfoTitle');
    const bodyEl = document.getElementById('requestInfoBody');
    const confirmBtn = document.getElementById('requestInfoConfirm');
    const cancelBtn = document.getElementById('requestInfoCancel');
    if (!overlay || !titleEl || !bodyEl || !confirmBtn || !cancelBtn) {
      resolve(true);
      return;
    }
    titleEl.textContent = title || 'Verzoek openen';
    bodyEl.textContent = body || '';
    confirmBtn.textContent = confirmLabel || 'OK';
    cancelBtn.textContent = cancelLabel || 'Annuleren';
    if (allowCancel === false) {
      cancelBtn.classList.add('hidden');
    } else {
      cancelBtn.classList.remove('hidden');
    }
    overlay.classList.remove('hidden');
    const close = (result) => {
      overlay.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onConfirm = (e) => {
      e?.preventDefault?.();
      close(true);
    };
    const onCancel = (e) => {
      e?.preventDefault?.();
      close(false);
    };
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
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
          refreshInboxEntry(pendingShare.id, { silent: true }).catch(() => {});
          try { sessionStorage.setItem('lastAction', 'shared_none'); } catch {}
          try { window.location.hash = '#/done'; } catch {}
          showInboxNotice('Geen gegevens gedeeld; sessiecode is vervallen.');
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
      refreshInboxEntry(pendingShare.id, { silent: true }).catch(() => {});
    } catch {}
    try { sessionStorage.setItem('lastAction', 'shared'); } catch {}
    try { window.location.hash = '#/done'; } catch {}
    showInboxNotice('Gegevens gedeeld; sessiecode is nu ongeldig.');
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
        let meta = await ensureSessionMeta(id, { preferRequest: true, client: f });
        if (!intent) {
          intent = (meta && (meta.intent || (meta.payload && meta.payload.intent)))
            ? String(meta.intent || meta.payload.intent).toLowerCase()
            : '';
        }
        if (intent === 'use_card') {
          markInboxEntryRead(id);
          await launchShareFlow(id, meta, { client: f });
          refreshInboxEntry(id, { silent: true }).catch(() => {});
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

      const success = await addCardFromOfferSession(id, pendingMeta.get(id), { client: f });
      if (success) {
        refreshInboxEntry(id, { silent: true }).catch(() => {});
        try { sessionStorage.setItem('lastAction', 'added'); } catch {}
        showInboxNotice('Gegevens toegevoegd; sessiecode is nu ongeldig.');
      }
    });
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadJson('../data/card-types.json').then((s) => { uiSchema = s || {}; renderCards(); });
  loadJson('../data/use-scenarios.json').then((s) => { setScenarioAttributes(s || {}); }).catch(() => {});
  migrateState();
  renderCards();
  pruneInboxSessions();
  renderInbox();
  startInboxPolling();
  inboxSessions.forEach((entry) => { refreshInboxEntry(entry.id, { silent: true }).catch(() => {}); });
  captureSessionFromUrl();
  attachScanHandlers();
  window.addEventListener('hashchange', () => { onRouteChange(); captureSessionFromUrl(); });
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

  const inboxToggle = document.getElementById('inboxToggle');
  inboxToggle?.addEventListener('click', (e) => { e.preventDefault(); toggleInboxDrawer(); });
  document.querySelector('[data-inbox-dismiss]')?.addEventListener('click', (e) => { e.preventDefault(); closeInboxDrawer(); });
  document.getElementById('inboxClose')?.addEventListener('click', (e) => { e.preventDefault(); closeInboxDrawer(); });
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
function titleForEntry(entry) {
  if (!entry) return 'Verzoek';
  if (entry.title) return entry.title;
  if (entry.type) return labelForType(entry.type);
  return 'Verzoek';
}
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const actionEl = target.closest('[data-inbox-action]');
  if (!actionEl) return;
  const action = actionEl.getAttribute('data-inbox-action');
  const sessionId = actionEl.getAttribute('data-session-id');
  if (!sessionId) return;
  event.preventDefault();
  if (action === 'open') {
    openInboxSession(sessionId);
  } else if (action === 'dismiss') {
    removeInboxEntry(sessionId);
    showInboxNotice('Verzoek verwijderd');
  } else if (action === 'refresh') {
    refreshInboxEntry(sessionId)
      .then(() => showInboxNotice('Status bijgewerkt'))
      .catch(() => showInboxNotice('Status ophalen mislukt'));
  }
});
