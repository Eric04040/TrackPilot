// Meldet der Seitenleiste, welcher Track auf dieser Album- oder Trackseite gerade läuft, und gibt ihr die Seite zum Auslesen.
(() => {
  const read = () => {
    const el = document.querySelector('.inline_player .title, .track_info .title, #name-section .trackTitle');
    return { type: 'nowPlaying', url: location.origin + location.pathname, title: el?.textContent.trim() || '' };
  };
  let last = null, timer = 0, poll = 0, obs = null;
  // Nach einem Update der Erweiterung bleibt dieses alte Skript in offenen Tabs zurück, ohne Verbindung:
  // dann still aufräumen statt alle paar Sekunden Fehler zu werfen (F5 lädt die neue Version)
  const alive = () => {
    if (chrome.runtime?.id) return true;
    clearInterval(poll); clearTimeout(timer); obs?.disconnect();
    document.getElementById('trackpilot-toggle')?.remove();
    document.getElementById('trackpilot-hint')?.remove();
    return false;
  };
  const send = () => {
    if (!alive()) return;
    const m = read();
    if (m.title === last) return;
    last = m.title;
    chrome.runtime.sendMessage(m).catch(() => {});   // Seitenleiste evtl. gerade zu
  };
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'getNow') reply(read());
    // Seitenleiste liest die schon geladene Seite, statt sie neu herunterzuladen
    if (msg?.type === 'getHtml') reply({ url: location.origin + location.pathname, html: document.documentElement.outerHTML });
    // Herz aus der Seitenleiste: klickt Bandcamps eigenen Wishlist-Knopf auf dieser Track-Seite
    if (msg?.type === 'wishlist') { clickWishlist(msg.add).then(reply); return true; }
    // TrackPilot spielt ein Lied: Bandcamps eigenen Player auf dieser Seite anhalten
    if (msg?.type === 'pauseMedia') document.querySelectorAll('audio, video').forEach((a) => { if (!a.paused) a.pause(); });
    // 0.9.75: Opera zeigt die Seitenleiste nicht – Hinweis zum Anheften neben der Lasche
    if (msg?.type === 'operaHint' && window.top === window) operaHint();
  });
  // Kleine Meldung links neben der Lasche » «, hell/dunkel wie in den Einstellungen; ~8 s oder bis zum Klick.
  // Shadow DOM, damit Bandcamps CSS nichts verstellt; Text über t() aus i18n.js (läuft vorher als Content-Skript)
  let hintTimer = 0;
  async function operaHint() {
    const s = (await chrome.storage.local.get('settings').catch(() => ({}))).settings || {};
    const nav = (navigator.language || 'de').slice(0, 2);
    LANG = s.lang || (LANGS[nav] ? nav : 'de');
    document.getElementById('trackpilot-hint')?.remove();
    clearTimeout(hintTimer);
    const host = document.createElement('div');
    host.id = 'trackpilot-hint';
    host.dataset.theme = s.theme || 'system';
    host.style.cssText = 'all:initial;position:fixed;right:34px;top:112px;z-index:2147483647';
    const L = '--bg:#fff;--text:#1b2227;--line:#dde3e8;--accent:#1890b0;--shadow:rgba(16,32,48,.22);color-scheme:light;';
    const D = '--bg:#1e252b;--text:#e5eaee;--line:#2b343c;--accent:#38b4d6;--shadow:rgba(0,0,0,.55);color-scheme:dark;';
    const R = host.attachShadow({ mode: 'open' });
    R.innerHTML = `<style>:host{${L}}:host([data-theme="dark"]){${D}}@media (prefers-color-scheme: dark){:host(:not([data-theme="light"])){${D}}}
.h{box-sizing:border-box;max-width:min(320px,calc(100vw - 50px));padding:10px 12px;border-radius:10px;background:var(--bg);color:var(--text);
  border:1px solid var(--line);border-left:3px solid var(--accent);box-shadow:0 6px 18px var(--shadow);font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}</style>
<div class="h" role="status"></div>`;
    R.querySelector('.h').textContent = t('TrackPilot in Opera: in der Seitenleiste anheften – unten in der Seitenleiste auf „…“ → Erweiterungen → TrackPilot.');
    const close = () => { clearTimeout(hintTimer); host.remove(); };
    host.addEventListener('click', close);
    (document.body || document.documentElement).appendChild(host);
    hintTimer = setTimeout(close, 8000);
  }
  // Bandcamps Player startet auf dieser Seite: TrackPilot hält sein Lied an
  document.addEventListener('play', (e) => {
    if (!(e.target instanceof HTMLMediaElement) || !alive()) return;
    chrome.runtime.sendMessage({ type: 'bcPlaying' }).catch(() => {});
  }, true);
  const shown = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const q = (sel) => [...document.querySelectorAll(sel)].find(shown);
  const ADD = '#wishlist-msg, .wishlist-msg, #collect-item .wishlist, button[aria-label*="ishlist"]:not([aria-pressed="true"])';
  const DONE = '#wishlisted-msg, .wishlisted-msg, #collect-item .wishlisted, button[aria-label*="ishlist"][aria-pressed="true"]';
  // Zeitgrenzen nach der Uhr, nicht nach Durchläufen: im unsichtbaren Hintergrund-Tab bremst Chrome Timer auf 1 pro Sekunde
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function clickWishlist(add) {
    for (const end = Date.now() + 6000; Date.now() < end && !q(ADD) && !q(DONE);) await sleep(100);   // Knopf erscheint erst nach dem Laden
    if (add ? q(DONE) : q(ADD)) return { ok: true, already: true };
    const btn = add ? q(ADD) : q(DONE);
    if (!btn) return { ok: false, error: 'Wishlist-Knopf nicht gefunden' + (document.querySelector('.log-in-link, a[href*="/login"]') ? ' (nicht eingeloggt?)' : '') };
    (btn.querySelector('a, button') || btn).click();
    for (const end = Date.now() + 8000; Date.now() < end;) {
      await sleep(150);
      if (add ? q(DONE) : q(ADD)) return { ok: true };
    }
    return { ok: false, error: 'Bandcamp hat den Klick nicht bestätigt' };
  }
  // Lasche am rechten Rand der Seite (direkt neben der Leiste): ein Klick blendet die Leiste aus bzw. wieder ein
  if (window.top === window) {
    document.getElementById('trackpilot-toggle')?.remove();   // Rest einer älteren Version
    const tab = document.createElement('button');
    tab.id = 'trackpilot-toggle';
    tab.textContent = '»';
    tab.title = 'TrackPilot (Alt + T)';
    tab.style.cssText = 'position:fixed;right:0;top:120px;z-index:2147483647;width:26px;height:44px;padding:0;border:0;'
      + 'border-radius:8px 0 0 8px;background:#1890b0;color:#fff;font:700 18px/44px system-ui,sans-serif;cursor:pointer;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.85;text-align:center';
    tab.onmouseenter = () => { tab.style.opacity = '1'; };
    tab.onmouseleave = () => { tab.style.opacity = '.85'; };
    tab.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (alive()) chrome.runtime.sendMessage({ type: 'togglePanel' }).catch(() => {}); };
    const show = (open) => { tab.textContent = open ? '»' : '«'; };
    (document.body || document.documentElement).appendChild(tab);
    const ask = () => alive() && chrome.runtime.sendMessage({ type: 'panelState?' }).then((r) => show(!!r?.open)).catch(() => {});
    ask();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) ask(); });
    window.addEventListener('focus', ask);
    poll = setInterval(() => { if (!document.hidden) ask(); }, 3000);   // falls eine Meldung verloren ging (z. B. nach Neustart des Hintergrunds)
    chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'panelState') show(m.open); });
  }
  // 0.9.62: Fan-Profil (bandcamp.com/name): folgst du ihm? Bandcamps Knopf zeigt dann „Following“
  const fanUser = location.hostname === 'bandcamp.com' && (location.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/) || [])[1];
  let lastFol = null, lastDiag = '';
  // 0.9.63: Bandcamps Knopf trägt oft alle Texte (Follow/Following/Unfollow) und blendet per CSS um,
  // darum zählt nur der sichtbare Text (innerText); Zähler-Reiter („following 170“) fallen über die Ziffern raus
  const cls = (el) => String(el.className?.baseVal ?? el.className ?? '') + ' ' + (el.id || '');
  const follow = () => {
    if (!fanUser || !alive()) return;
    const cands = [...document.querySelectorAll('button, a, [role="button"], [class*="follow" i], [id*="follow" i]')]
      .filter((el) => shown(el) && !el.closest('a[href*="/follow"]') && !/\d/.test(el.textContent)
        && el.textContent.length < 80 && /follow/i.test(el.innerText || ''));
    const btn = cands.find((el) => el.matches('button, [role="button"]')) || cands.find((el) => /follow/i.test(cls(el)));
    let on = null, how = '';
    if (btn) {
      const vis = (btn.innerText || '').trim();
      if (/[✓✔]/.test(vis)) on = true;   // Haken = du folgst
      else if (/^\W*follow\W*$/i.test(vis)) on = false;
      else if (/following|unfollow|entfolgen/i.test(vis)) on = true;
      else if (/\bfollowing\b|is-following|\bactive\b/i.test(cls(btn)) || btn.getAttribute('aria-pressed') === 'true') on = true;
      else on = false;
      how = `${btn.tagName.toLowerCase()}.${cls(btn).trim().replace(/\s+/g, '.')} „${vis.replace(/\s+/g, ' ').slice(0, 40)}“ → ${on ? 'folgst' : 'folgst nicht'}`;
    } else {
      how = 'kein Folgen-Knopf · ' + ([...document.querySelectorAll('[class*="follow" i], [id*="follow" i]')].slice(0, 6)
        .map((el) => `${el.tagName.toLowerCase()}.${cls(el).trim().replace(/\s+/g, '.')} „${(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)}“`).join(' | ') || 'nichts mit „follow“');
    }
    // Für die Fehlersuche: was auf dem Profil erkannt wurde, landet einmal im Protokoll der Seitenleiste
    if (how !== lastDiag) { lastDiag = how; chrome.runtime.sendMessage({ type: 'fanFollowDiag', u: fanUser, how }).catch(() => {}); }
    if (on === null || on === lastFol) return;
    lastFol = on;
    chrome.runtime.sendMessage({ type: 'fanFollow', u: fanUser, on }).catch(() => {});
  };
  send(); follow();
  obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { send(); follow(); }, 300); });
  obs.observe(document.body || document.documentElement, { subtree: true, childList: true, characterData: true });
})();
