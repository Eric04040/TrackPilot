// Klick auf das Erweiterungs-Symbol öffnet die Seitenleiste neben der Website.
// 0.9.75: nur noch Seitenleiste, nie ein eigenes Fenster. Chrome: chrome.sidePanel; Opera: seine eigene Seitenleiste (manifest sidebar_action).
// Opera meldet chrome.sidePanel teils, zeigt aber nichts – meldet sich die Leiste nicht binnen HINT_WAIT, zeigt die Bandcamp-Seite,
// wie man TrackPilot in Operas Seitenleiste anheftet
const isOpera = /\bOPR\//.test(navigator.userAgent) || !!navigator.userAgentData?.brands?.some((b) => /opera/i.test(b.brand));
const hasSide = !!chrome.sidePanel?.open && !isOpera;   // Chrome: wie immer
const HINT_WAIT = 1500;
if (isOpera) chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch?.(() => {});   // Klick selbst behandeln
if (hasSide) {
  const panelOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.runtime.onInstalled.addListener(panelOnClick);
  chrome.runtime.onStartup.addListener(panelOnClick);
} else chrome.action.onClicked.addListener((tab) => { if (tab) toggle(tab.windowId); });   // feuert nur ohne openPanelOnActionClick
// 0.9.75: Reste von eigenem Fenster und Andocken (0.9.69–0.9.73) einmal wegräumen
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['dock', 'sideOk']).catch(() => {});
  chrome.storage.session.remove('popups').catch(() => {});
});
// 0.9.72: Tempo-Regler der Player-Leiste ist weg – seine gespeicherten Vorgaben auch
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('barPrefs').catch(() => {}));

// Tastenkürzel (Standard Alt+T, änderbar unter chrome://extensions/shortcuts): Leiste ein- und ausblenden.
// Die offene Leiste meldet sich über einen Port; ist sie offen, schließt sie sich selbst, sonst wird sie geöffnet.
const open = new Map();   // windowId -> Port
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  port.onMessage.addListener((m) => {
    if (m.windowId != null) { port.windowId = m.windowId; open.set(m.windowId, port); tell(m.windowId); }
    if (m.type === 'bpmRes') bpmDone(m.id, m.res);
  });
  port.onDisconnect.addListener(() => {
    for (const [id, w] of bpmWait) if (w.port === port) bpmDone(id, null);
    if (open.get(port.windowId) === port) { open.delete(port.windowId); tell(port.windowId); }
    closeLikeTabs(port.windowId);
  });
});
// Herz-Klick über einen unsichtbaren Tab (panel.js likeViaTab): wird die Leiste mittendrin geschlossen, den Tab wegräumen.
// Kurz warten – verbindet sich die Leiste gleich wieder (Neustart des Hintergrunds, Neuladen), läuft sie noch und räumt selbst auf.
async function closeLikeTabs(windowId) {
  if (windowId == null) return;
  await new Promise((r) => setTimeout(r, 1500));
  if (open.has(windowId)) return;
  const all = (await chrome.storage.session.get('likeTabs').catch(() => ({}))).likeTabs;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return;
  const ids = Object.keys(all).filter((id) => all[id] === windowId);
  if (!ids.length) return;
  for (const id of ids) { chrome.tabs.remove(Number(id)).catch(() => {}); delete all[id]; }
  await chrome.storage.session.set({ likeTabs: all }).catch(() => {});
}
function toggle(windowId) {
  const port = open.get(windowId);
  if (port) { port.postMessage({ type: 'close' }); return; }
  if (hasSide) { chrome.sidePanel.open({ windowId }).catch(() => {}); return; }
  // Opera: Seitenleiste versuchen (muss im selben Klick passieren); kommt keine, Hinweis zum Anheften auf der Bandcamp-Seite
  let tried = false;
  try { const p = chrome.sidePanel?.open?.({ windowId }); if (p) { tried = true; p.catch?.(() => {}); } } catch {}
  if (!tried) { operaHint(windowId); return; }
  setTimeout(() => { if (!open.has(windowId)) operaHint(windowId); }, HINT_WAIT);
}
async function operaHint(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab && /^https:\/\/([^/]+\.)?bandcamp\.com\//.test(tab.url || '')) chrome.tabs.sendMessage(tab.id, { type: 'operaHint' }).catch(() => {});
}
// Die Lasche am rechten Seitenrand (content.js) zeigt » bei offener und « bei geschlossener Leiste
async function tell(windowId) {
  for (const tb of await chrome.tabs.query({ windowId }).catch(() => [])) {
    chrome.tabs.sendMessage(tb.id, { type: 'panelState', open: open.has(windowId) }).catch(() => {});
  }
}
chrome.commands.onCommand.addListener((cmd, tab) => { if (cmd === 'toggle-panel' && tab) toggle(tab.windowId); });
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.type === 'togglePanel' && sender.tab) toggle(sender.tab.windowId);
  if (m?.type === 'panelState?' && sender.tab) reply({ open: open.has(sender.tab.windowId) });
  // 0.9.70: BPM für die Player-Leiste auf Bandcamp (bar.js)
  if (m?.type === 'bpm?' && okStream(m.url)) { bpmViaPanel(m.url, sender.tab?.windowId).then(reply); return true; }
  if (m?.type === 'bpmBytes?' && okStream(m.url)) { streamB64(m.url).then(reply, () => reply(null)); return true; }
});

// ---------- 0.9.70: BPM für die Player-Leiste ----------
// Der Hintergrund hat kein AudioContext. Ist TrackPilot offen, rechnet die Leiste (darf bcbits.com laden, dekodiert schon Wellenformen);
// sonst holt der Hintergrund nur die Bytes (keine CORS-Sperre dank host_permissions) und die Seite dekodiert selbst.
const okStream = (u) => /^https:\/\/([\w-]+\.)*(bcbits|bandcamp)\.com\//.test(String(u || ''));
const bpmWait = new Map();   // id -> { port, done }
let bpmSeq = 0;
function bpmDone(id, res) { const w = bpmWait.get(id); if (!w) return; bpmWait.delete(id); w.done(res ?? null); }
function bpmViaPanel(url, windowId) {
  const port = open.get(windowId) || open.values().next().value;
  if (!port) return Promise.resolve(null);
  return new Promise((done) => {
    const id = ++bpmSeq, timer = setTimeout(() => bpmDone(id, null), 90000);
    bpmWait.set(id, { port, done: (r) => { clearTimeout(timer); done(r); } });
    try { port.postMessage({ type: 'bpm', id, url }); } catch { bpmDone(id, null); }
  });
}
async function streamB64(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const b = new Uint8Array(await res.arrayBuffer());
  if (b.length > 40e6) return null;   // kein Vorhör-Stream
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return { b64: btoa(s) };
}
