'use strict';
// 0.9.70: feste Player-Leiste unten auf Bandcamp (Feed, Album, Track, Fan-Seiten) mit BPM.
// 0.9.72: Tempo-Regler entfernt – die Leiste fasst playbackRate/preservesPitch nicht mehr an, der Platz geht an die Wellenform.
// Shadow DOM, damit Bandcamps CSS nichts verstellt. Texte über t() aus i18n.js, BPM über bpm.js – beide laufen vorher als Content-Skript.
// Das laufende Medium kommt aus play/pause/timeupdate auf document (Capture), egal welches <audio> Bandcamp gerade benutzt.
(() => {
  if (window.top !== window) return;
  // ---------- Selektoren: alles an einer Stelle, je Liste von genau nach grob ----------
  const SEL = {
    // Feed und Fan-Seiten: ein Eintrag (Story) mit Cover, Play-Knopf, Titel, „by …“, Wishlist
    story: 'li.story, .story, .collection-item-container, li[data-tralbumid], li[data-itemid], [data-story-id]',
    play: '.play-button, .playbutton, .play_status, .item_link_play, .track_play_auxiliary, [class*="play-button"], [class*="play_button"], [aria-label*="play" i]',
    title: ['.collection-item-title', '.tralbum-title', '.item-title', '.story-title .title', '[class*="item-title"]', '[class*="title"]'],
    artist: ['.collection-item-artist', '.artist-name', '.item-artist', '[class*="artist"]'],
    link: 'a.item-link[href*="/album/"], a.item-link[href*="/track/"], a[href*="/album/"], a[href*="/track/"], a.item-link[href]',
    cover: ['img.collection-item-art', 'img.tralbum-art-large', '.tralbum-art-container img', '[class*="art"] img', 'img[src*="bcbits.com/img"]'],
    wish: '.wishlist, .wishlist-link, [class*="wishlist" i], [aria-label*="wishlist" i], [title*="wishlist" i]',
    // Bandcamps kleiner „now playing“-Kasten (Rückfall: fester Kasten mit diesem Text)
    nowBox: '.carousel-player, #carousel-player, [class*="now-playing" i], [id*="now-playing" i], [class*="nowplaying" i]',
    // Album- und Trackseiten (Titel wie read() in content.js)
    pgPlayer: '.inline_player',
    pgTitle: ['.inline_player .title', '.track_info .title', '#name-section .trackTitle'],
    pgTitleLink: '.inline_player .title_link[href], .track_info a[href*="/track/"]',
    pgArtist: ['#name-section h3 span a', '#name-section h3 a', '[itemprop="byArtist"] a', '#band-name-location .title'],
    pgCover: ['#tralbumArt img', '.popupImage img'],
    pgPrev: '.inline_player .prevbutton, .prevbutton',
    pgNext: '.inline_player .nextbutton, .nextbutton',
    pgWishAdd: '#wishlist-msg, .wishlist-msg, #collect-item .wishlist, button[aria-label*="ishlist"]:not([aria-pressed="true"])',
    pgWishDone: '#wishlisted-msg, .wishlisted-msg, #collect-item .wishlisted, button[aria-label*="ishlist"][aria-pressed="true"]',
  };
  const H = 64;   // Höhe der Leiste
  const st = { on: true, theme: 'system' };
  let media = null, curSrc = '', started = false, dismissed = false, mode = 'story', story = null;
  let lastClick = null, lastClickAt = 0, info = {}, peaks = null, bpm = null;
  let host = null, R = null, tick = 0, raf = 0, padOrig = null, padPrio = '', nowBox = null, boxScan = 0;
  const diagSent = new Set();

  const alive = () => {
    if (chrome.runtime?.id) return true;
    teardown(); return false;
  };
  const send = (m) => { try { return chrome.runtime.sendMessage(m).catch(() => null); } catch { return Promise.resolve(null); } };
  // Was die Leiste nicht findet, landet einmal im Protokoll der TrackPilot-Leiste („Leiste: …“)
  const diag = (k, how) => { if (diagSent.has(k)) return; diagSent.add(k); send({ type: 'barDiag', how }); };
  const desc = (e) => (e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${String(e.className?.baseVal ?? e.className ?? '').trim() ? '.' + String(e.className?.baseVal ?? e.className).trim().split(/\s+/).join('.') : ''}` : '–');
  const txt = (e) => (e?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const qv = (sel, root = document) => [...root.querySelectorAll(sel)].find(visible);
  const imgSrc = (i) => i && (i.currentSrc || i.getAttribute('src') || i.dataset?.original || i.dataset?.src || '');
  const fmt = (n) => n.toLocaleString(LOCALES[LANG] || 'de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtTime = (s) => (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
  const active = () => st.on && started && !dismissed && !!media;

  // ---------- Kontext: welche Story / welche Seite spielt ----------
  const stories = () => {
    const all = [...document.querySelectorAll(SEL.story)].filter((s) => s.querySelector(SEL.play) && !host?.contains(s)), set = new Set(all);
    return all.filter((s) => { for (const o of s.querySelectorAll(SEL.story)) if (set.has(o)) return false; return true; });   // die innersten
  };
  const playBtn = (s) => s && (qv(SEL.play, s) || s.querySelector(SEL.play));
  const first = (sels, root, ok = () => true) => { for (const s of sels) for (const e of root.querySelectorAll(s)) if (ok(e)) return e; return null; };
  const boxTitle = () => {
    const b = nowBox || findNowBox();
    return b ? txt(first(SEL.title, b, (e) => txt(e).length > 0 && txt(e).length < 150)) : '';
  };
  function storyOf(el) {
    const s = el?.closest?.(SEL.story);
    return s && !host?.contains(s) ? s : null;
  }
  function resolve(fromPlay) {
    const recent = lastClick && Date.now() - lastClickAt < 4000 && lastClick.isConnected;
    const s = recent ? storyOf(lastClick) : null;
    if (s) { story = s; mode = 'story'; return; }
    if (recent && document.querySelector(SEL.pgPlayer)) { mode = 'page'; return; }
    if (!fromPlay && story?.isConnected) return;
    // ohne Klick (z. B. Bandcamp spielt selbst weiter): Story mit „playing“-Markierung, dann Titel im now-playing-Kasten
    const list = stories();
    const marked = list.find((x) => /\bplaying\b/i.test(String(x.className)) || x.querySelector('.playing, [class~="is-playing"]'));
    const bt = !marked && boxTitle(), byTitle = bt && list.find((x) => txt(first(SEL.title, x)) === bt);
    if (marked || byTitle) { story = marked || byTitle; mode = 'story'; return; }
    if (document.querySelector(SEL.pgPlayer)) { mode = 'page'; return; }
    if (story?.isConnected) return;
    story = null; mode = 'story';
    diag('story', `kein Story-Container zum Play-Knopf gefunden (${recent ? desc(lastClick) : 'kein Klick'}; ${list.length} Stories)`);
  }
  function readInfo() {
    const i = {};
    if (mode === 'page') {
      const has = (e) => txt(e).length > 0;
      i.title = txt(first(SEL.pgTitle, document, (e) => has(e) && visible(e)) || first(SEL.pgTitle, document, has));
      i.artist = txt(first(SEL.pgArtist, document, has)).replace(/^(by|von)\s+/i, '');
      i.cover = imgSrc(first(SEL.pgCover, document, (e) => !!imgSrc(e))) || document.querySelector('meta[property="og:image"]')?.content || '';
      i.link = document.querySelector(SEL.pgTitleLink)?.href || location.origin + location.pathname;
      const add = qv(SEL.pgWishAdd), done = qv(SEL.pgWishDone);
      i.wish = done || add ? { el: done || add, on: !!done } : null;
      i.prev = qv(SEL.pgPrev); i.next = qv(SEL.pgNext);
      const off = (b) => !b || /hiddenelem|disabled/i.test(String(b.className)) || b.getAttribute('aria-disabled') === 'true';
      if (off(i.prev)) i.prev = null;
      if (off(i.next)) i.next = null;
      if (!document.querySelector(SEL.pgPrev) && !document.querySelector(SEL.pgNext)) diag('pgskip', 'keine Vor/Zurück-Knöpfe auf der Seite (' + SEL.pgPrev + ')');
    } else if (story) {
      const okT = (e) => { const x = txt(e); return x.length > 0 && x.length < 150 && !/^(by|von)\s/i.test(x) && !e.querySelector(SEL.artist.join(',')); };
      i.title = txt(first(SEL.title, story, okT));
      let a = txt(first(SEL.artist, story, (e) => txt(e).length > 0 && txt(e).length < 150));
      if (!a) {   // Rückfall: Textknoten „by …“
        const w = document.createTreeWalker(story, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode());) if (/^\s*by\s+\S/i.test(n.nodeValue)) { a = n.nodeValue.trim(); break; }
      }
      i.artist = a.replace(/^(by|von)\s+/i, '');
      let im = first(SEL.cover, story, (e) => !!imgSrc(e));
      if (!im) im = [...story.querySelectorAll('img')].filter(imgSrc).sort((x, y) => y.offsetWidth * y.offsetHeight - x.offsetWidth * x.offsetHeight)[0];
      i.cover = imgSrc(im);
      i.link = story.querySelector(SEL.link)?.href || '';
      const we = [...story.querySelectorAll(SEL.wish)].find((e) => /wishlist/i.test(txt(e) + ' ' + String(e.className) + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.title || '')));
      if (we) {
        const el = we.closest('a, button, [role="button"]') || we.querySelector('a, button, [role="button"]') || we;
        const all = txt(el) + ' ' + String(el.className) + ' ' + String(we.className) + ' ' + (el.getAttribute('aria-label') || '');
        i.wish = { el, on: /wishlisted|in.wishlist|in your wishlist|♥/i.test(all) || el.getAttribute('aria-pressed') === 'true' };
      } else i.wish = null;
      const l = stories(), k = l.indexOf(story);
      i.prev = k > 0 ? playBtn(l[k - 1]) : null;
      i.next = k >= 0 && k < l.length - 1 ? playBtn(l[k + 1]) : null;
      if (!i.title) diag('title', `kein Titel in der Story (${desc(story)})`);
      if (!i.cover) diag('cover', `kein Cover in der Story (${desc(story)})`);
      if (!i.wish) diag('wish', `kein Wishlist-Link in der Story (${desc(story)})`);
    }
    if (!i.title) i.title = boxTitle() || document.title.split('|')[0].trim();
    info = i;
  }

  // ---------- Bandcamps now-playing-Kasten ----------
  const fixedUp = (e) => { for (let x = e, n = 0; x && x !== document.body && x !== document.documentElement && n < 7; x = x.parentElement, n++) { const p = getComputedStyle(x).position; if (p === 'fixed' || p === 'sticky') return x; } return null; };
  const smallBox = (x) => { const r = x.getBoundingClientRect(); return r.width < innerWidth * 0.6 && r.height < innerHeight * 0.5 && !x.querySelector(SEL.story) && !x.contains(host); };
  function findNowBox(deep) {
    if (nowBox?.isConnected) return nowBox;
    for (const e of document.querySelectorAll(SEL.nowBox)) { const f = fixedUp(e); if (f && smallBox(f)) return f; }
    if (!deep || !document.body) return null;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/^\s*now playing\s*$/i.test(n.nodeValue) ? 1 : 3) });
    for (let n; (n = w.nextNode());) { const f = fixedUp(n.parentElement); if (f && smallBox(f)) return f; }
    return null;
  }
  // nur ausblenden, wenn der Kasten sicher erkannt ist (fest positioniert, klein, keine Stories darin)
  function hideBox(on) {
    if (!on) { document.querySelectorAll('[data-trackpilot-hidden]').forEach((e) => e.removeAttribute('data-trackpilot-hidden')); nowBox = null; return; }
    const now = Date.now(), deep = now - boxScan > 3000;
    if (deep) boxScan = now;
    const b = findNowBox(deep);
    if (!b) return;
    if (!document.getElementById('trackpilot-bar-css')) {
      const s = document.createElement('style');
      s.id = 'trackpilot-bar-css';
      s.textContent = '[data-trackpilot-hidden]{display:none!important}';
      (document.head || document.documentElement).appendChild(s);
    }
    if (b !== nowBox) diag('box', `Bandcamps now-playing-Kasten ausgeblendet (${desc(b)})`);
    nowBox = b;
    b.setAttribute('data-trackpilot-hidden', '');
  }
  function pad(on) {
    const b = document.body;
    if (!b) return;
    if (on && padOrig == null) {
      padOrig = b.style.getPropertyValue('padding-bottom'); padPrio = b.style.getPropertyPriority('padding-bottom');
      const cur = parseFloat(getComputedStyle(b).paddingBottom) || 0;
      b.style.setProperty('padding-bottom', `${cur + H}px`, 'important');
    } else if (!on && padOrig != null) {
      if (padOrig) b.style.setProperty('padding-bottom', padOrig, padPrio); else b.style.removeProperty('padding-bottom');
      padOrig = null;
    }
  }

  // ---------- Oberfläche ----------
  const ICON = {
    prev: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 2.5h2v11H3zM14 2.8v10.4L6 8z" fill="currentColor"/></svg>',
    next: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M11 2.5h2v11h-2zM2 2.8v10.4L10 8z" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 2.5v11l9-5.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>',
  };
  const LIGHT = '--bg:#fff;--text:#1b2227;--muted:#66727c;--line:#dde3e8;--accent:#1890b0;--chip:#e6f3f7;--heart:#d6345a;--shadow:rgba(16,32,48,.22);color-scheme:light;';
  const DARK = '--bg:#1e252b;--text:#e5eaee;--muted:#93a0aa;--line:#2b343c;--accent:#38b4d6;--chip:#1c3038;--heart:#ff6b8a;--shadow:rgba(0,0,0,.55);color-scheme:dark;';
  const CSS = `
:host{${LIGHT}}
:host([data-theme="dark"]){${DARK}}
@media (prefers-color-scheme: dark){:host(:not([data-theme="light"])){${DARK}}}
*{box-sizing:border-box}
.hidden{display:none!important}
.bar{position:relative;height:${H}px;display:flex;align-items:center;gap:12px;padding:0 10px 0 8px;background:var(--bg);color:var(--text);
  border-top:2px solid var(--accent);box-shadow:0 -8px 20px -10px var(--shadow);font:13px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}
button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-grid;place-items:center;color:inherit;border-radius:6px}
button:focus-visible,a:focus-visible,canvas:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button:disabled{opacity:.3;cursor:default}
a{color:inherit;text-decoration:none}
.cv{flex:none;width:48px;height:48px;border-radius:4px;background:var(--chip) center/cover no-repeat}
.meta{flex:none;width:clamp(120px,19vw,270px);min-width:0;display:flex;flex-direction:column;gap:2px}
.ti{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.by{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ti:hover,.by:hover{text-decoration:underline}
.ctl{flex:none;display:flex;align-items:center;gap:4px}
.ctl .sk{width:30px;height:30px;color:var(--muted)}
.ctl .sk:hover:not(:disabled){background:var(--chip);color:var(--text)}
.pp{width:40px;height:40px;border-radius:50%!important;background:var(--accent);color:#fff}
.pp:hover{filter:brightness(1.08)}
.pos{flex:1;min-width:160px;display:flex;align-items:center;gap:12px}
canvas{flex:1;min-width:0;height:34px;cursor:pointer;color:var(--accent);border-top:0 none var(--muted);touch-action:none}
.tm{flex:none;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.wish{flex:none;width:32px;height:32px;font-size:20px;color:var(--muted)}
.wish:hover{background:var(--chip)}
.wish.on{color:var(--heart)}
.bpm{flex:none;display:inline-flex;align-items:baseline;justify-content:center;gap:4px;min-width:88px;height:36px;line-height:36px;padding:0 10px;background:var(--chip);font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.bpm small{font-weight:400;font-size:11px;color:var(--muted)}
.x{flex:none;width:28px;height:28px;color:var(--muted)}
.x:hover{background:var(--chip);color:var(--text)}
@media (max-width:760px){.tm,.wish{display:none}.meta{width:120px}}`;
  const $ = (s) => R.querySelector(s);
  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'trackpilot-bar';
    host.dataset.theme = st.theme;
    host.style.cssText = `all:initial;position:fixed;left:0;right:0;bottom:0;height:${H}px;z-index:2147483646;display:none`;   // unter der Lasche »
    R = host.attachShadow({ mode: 'open' });
    R.innerHTML = `<style>${CSS}</style><div class="bar" role="region">
      <a class="cv" aria-hidden="true" tabindex="-1"></a>
      <div class="meta"><a class="ti"></a><a class="by"></a></div>
      <div class="ctl"><button class="sk prev">${ICON.prev}</button><button class="pp">${ICON.play}</button><button class="sk next">${ICON.next}</button></div>
      <div class="pos"><canvas role="slider" aria-valuemin="0"></canvas><span class="tm">0:00 / 0:00</span></div>
      <button class="wish">♡</button>
      <span class="bpm"></span>
      <button class="x">✕</button></div>`;
    (document.body || document.documentElement).appendChild(host);
    $('.pp').addEventListener('click', () => { if (!media) return; media.paused ? media.play().catch(() => {}) : media.pause(); });
    $('.prev').addEventListener('click', () => skip(-1));
    $('.next').addEventListener('click', () => skip(1));
    $('.wish').addEventListener('click', clickWish);
    $('.x').addEventListener('click', () => { dismissed = true; update(); });
    // Spulen: Klick oder Ziehen auf der Wellenform
    const cv = $('canvas');
    const seek = (e) => { const d = media?.duration, r = cv.getBoundingClientRect(); if (d && r.width) media.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d; draw(); };
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); cv._drag = true; seek(e); });
    cv.addEventListener('pointermove', (e) => { if (cv._drag) seek(e); });
    cv.addEventListener('pointerup', () => { cv._drag = false; });
    cv.addEventListener('pointercancel', () => { cv._drag = false; });
    new ResizeObserver(() => draw()).observe(cv);
    texts();
  }
  function texts() {
    if (!R) return;
    const set = (s, k) => { const e = $(s); e.title = k; e.setAttribute('aria-label', k); };
    set('.prev', t('Vorheriges Lied')); set('.next', t('Nächstes Lied')); set('.x', t('Leiste bis zum nächsten Abspielen ausblenden'));
    $('canvas').setAttribute('aria-label', t('Position im Lied'));
    $('.ti').title = t('Release öffnen');
    $('.bar').setAttribute('aria-label', 'TrackPilot');
    render();
  }
  function render() {
    if (!R || !active()) return;
    const i = info;
    $('.cv').style.backgroundImage = i.cover ? `url("${String(i.cover).replace(/["\\]/g, '')}")` : '';
    for (const a of [$('.cv'), $('.ti'), $('.by')]) { if (i.link) a.href = i.link; else a.removeAttribute('href'); }
    $('.ti').textContent = i.title || '';
    $('.by').textContent = i.artist ? t('von {artist}', { artist: i.artist }) : '';
    $('.prev').disabled = !i.prev; $('.next').disabled = !i.next;
    const w = $('.wish');
    w.classList.toggle('hidden', !i.wish);
    if (i.wish) { w.classList.toggle('on', i.wish.on); w.textContent = i.wish.on ? '♥' : '♡'; const k = t(i.wish.on ? 'Von der Wishlist entfernen' : 'Auf die Wishlist setzen'); w.title = k; w.setAttribute('aria-label', k); }
    renderPlay(); renderBpm(); draw();
  }
  function renderPlay() {
    if (!R || !media) return;
    const pb = $('.pp'), k = t(media.paused ? 'Abspielen' : 'Pause');
    pb.innerHTML = media.paused ? ICON.play : ICON.pause;
    pb.title = k; pb.setAttribute('aria-label', k);
    pb.dataset.state = media.paused ? 'paused' : 'playing';
    const d = media.duration;
    $('.tm').textContent = `${fmtTime(media.currentTime)} / ${fmtTime(d)}`;
    const cv = $('canvas');
    cv.setAttribute('aria-valuemax', String(Math.round(d || 0))); cv.setAttribute('aria-valuenow', String(Math.round(media.currentTime || 0)));
    cv.setAttribute('aria-valuetext', $('.tm').textContent);
  }
  function renderBpm() {
    if (!R) return;
    const b = $('.bpm'), base = bpm?.bpm || 0;   // 0.9.76: nur der erkannte Wert, keine ×2/÷2-Korrektur mehr
    if (base) {
      b.innerHTML = `${fmt(base)}<small>BPM</small>`;
      b.title = t('BPM geschätzt');
    } else {
      b.innerHTML = '–<small>BPM</small>';
      b.title = t(bpm?.loading ? 'BPM werden ermittelt …' : 'BPM nicht ermittelbar');
    }
    b.classList.toggle('loading', !!bpm?.loading);
    b.setAttribute('aria-label', b.textContent + ' – ' + b.title);
  }
  // Wellenform wie im TrackPilot-Player; ohne Wellenform gleichmäßige flache Balken = Fortschrittsbalken
  function draw() {
    if (!R || !active()) return;
    const cv = $('canvas'), w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'), cs = getComputedStyle(cv);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const dur = media.duration || 0, played = dur ? (media.currentTime / dur) * w : 0;
    const b = media.buffered, buf = dur && b.length ? (b.end(b.length - 1) / dur) * w : 0;
    const bw = 2, gap = 1, n = Math.max(1, Math.floor((w + gap) / (bw + gap))), pk = peaks;
    for (let i = 0; i < n; i++) {
      let v = 0.16;
      if (pk) { v = 0; for (let k = Math.floor((i / n) * pk.length), e = Math.max(k + 1, Math.floor(((i + 1) / n) * pk.length)); k < e; k++) v = Math.max(v, pk[k]); }
      const bh = Math.max(2, Math.round(v * h)), x = i * (bw + gap);
      if (x + bw / 2 <= played) { g.fillStyle = cs.color; g.globalAlpha = 1; }
      else { g.fillStyle = cs.borderTopColor; g.globalAlpha = x <= buf ? 0.6 : 0.32; }
      g.fillRect(x, (h - bh) / 2, bw, bh);
    }
    g.globalAlpha = 1;
  }
  const loop = () => { raf = 0; if (active() && !media.paused) { draw(); renderPlay(); raf = requestAnimationFrame(loop); } };

  // ---------- Steuerung ----------
  function skip(dir) {
    readInfo();
    const b = dir < 0 ? info.prev : info.next;
    if (!b) { render(); return; }
    (b.matches('a, button, [role="button"]') ? b : b.querySelector('a, button, [role="button"]') || b).click();
  }
  function clickWish() {
    const w = info.wish;
    if (!w?.el?.isConnected) return;
    w.el.click();
    for (const ms of [600, 1500, 3000]) setTimeout(() => { if (active()) { readInfo(); render(); } }, ms);
  }

  // ---------- BPM ----------
  // Schlüssel: Track-ID aus Bandcamps Stream-Adresse (…/mp3-128/<id>?token…, Feed/Sammlung: …?track_id=<id>),
  // sonst Adresse ohne wechselnde Teile (Zeit, Token) – 0.9.75: vorher fiel der Anfrageteil ganz weg, alle Feed-Lieder teilten einen Wert
  const keyOf = (u) => {
    const s = String(u), m = s.match(/\/mp3-[\w-]+\/(\d+)/) || s.match(/[?&](?:track_id|id)=(\d+)/);
    if (m) return 't' + m[1];
    try { const x = new URL(s); for (const p of ['ts', 't', 'token', 'p']) x.searchParams.delete(p); x.hash = ''; return 'u' + x.href; } catch { return s; }
  };
  async function saveBpm(key, b, f) {
    if (!alive() || !key || !b) return;
    const all = (await chrome.storage.local.get('bpm').catch(() => ({}))).bpm;
    const map = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    map[key] = [b, f || 1, Date.now()];
    const ks = Object.keys(map);
    if (ks.length > 2000) ks.sort((x, y) => (map[x][2] || 0) - (map[y][2] || 0)).slice(0, ks.length - 2000).forEach((k) => delete map[k]);
    await chrome.storage.local.set({ bpm: map }).catch(() => {});
  }
  // Wege zu den Bytes: 1. offene TrackPilot-Leiste (über den Hintergrund), 2. selbst laden (scheitert, wenn Bandcamps Server kein CORS erlaubt),
  // 3. der Hintergrund lädt (darf bcbits.com) und schickt die Bytes, die Seite dekodiert
  async function analyze(url) {
    const r = await send({ type: 'bpm?', url });
    if (r && (r.bpm || r.peaks)) return { ...r, via: 'panel' };
    try {
      const res = await fetch(url);
      if (res.ok) return { ...(await tpAnalyze(await res.arrayBuffer())), via: 'page' };
    } catch {}
    const b = await send({ type: 'bpmBytes?', url });
    if (b?.b64) {
      try {
        const bin = atob(b.b64), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return { ...(await tpAnalyze(u8.buffer)), via: 'bg' };
      } catch {}
    }
    return null;
  }
  const memo = new Map();   // Schlüssel → { bpm, peaks } dieser Seite
  async function newTrack() {
    curSrc = media.currentSrc || media.src || '';
    const key = keyOf(curSrc), url = curSrc;
    peaks = null;
    bpm = { key, loading: true };
    if (!url || /^(blob|data):/.test(url)) { bpm.loading = false; render(); diag('src', 'Stream-Adresse nicht lesbar (' + url.slice(0, 40) + ')'); return; }
    render();
    const m = memo.get(key);
    const cache = alive() ? ((await chrome.storage.local.get('bpm').catch(() => ({}))).bpm || {})[key] : null;
    if (bpm.key !== key) return;
    if (Array.isArray(cache) && cache[0]) { bpm.bpm = cache[0]; renderBpm(); }
    const res = m || await analyze(url);
    if (res && !m) memo.set(key, { bpm: res.bpm, peaks: res.peaks, via: res.via });
    if (bpm.key !== key) { if (res?.bpm && !cache) saveBpm(key, res.bpm, 1); return; }
    bpm.loading = false;
    if (res?.peaks) peaks = res.peaks;
    if (host && res?.via) host.dataset.bpmVia = res.via;
    if (!bpm.bpm && res?.bpm) { bpm.bpm = res.bpm; saveBpm(key, res.bpm, 1); }
    if (!res) diag('bpm', 'BPM: Stream nicht ladbar (weder über TrackPilot, die Seite noch den Hintergrund) – ' + url.split('/')[2]);
    render();
  }

  // ---------- Sichtbarkeit ----------
  function update() {
    const on = active();
    if (on) build();
    if (host) host.style.display = on ? 'block' : 'none';
    pad(on); hideBox(on);
    clearInterval(tick); tick = 0;
    if (on) {
      tick = setInterval(() => { if (!alive() || !active()) return; if (mode === 'page' || !story?.isConnected) resolve(false); readInfo(); hideBox(true); render(); }, 1500);
      readInfo(); render();
      if (!media.paused && !raf) raf = requestAnimationFrame(loop);
    }
  }
  function teardown() {
    clearInterval(tick); tick = 0;
    try { pad(false); hideBox(false); } catch {}
    host?.remove(); host = null; R = null;
    for (const [ev, fn] of LIS) document.removeEventListener(ev, fn, true);
  }

  // ---------- Ereignisse ----------
  const onClick = (e) => { const x = e.composedPath?.()[0] || e.target; if (host && host.contains(x)) return; if (x instanceof Element) { lastClick = x; lastClickAt = Date.now(); } };
  const onMedia = (e) => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement) || !alive()) return;
    if (e.type === 'play') {
      if (!st.on) return;
      const changed = m !== media || (m.currentSrc || m.src) !== curSrc;
      media = m; started = true; dismissed = false;
      resolve(true);
      update();
      if (changed) newTrack();
      return;
    }
    if (m !== media) return;
    if ((e.type === 'loadedmetadata' || e.type === 'durationchange') && (m.currentSrc || m.src) !== curSrc && active()) { resolve(false); readInfo(); newTrack(); }
    if (!active()) return;
    renderPlay(); draw();
    if (e.type === 'playing' && !raf) raf = requestAnimationFrame(loop);
  };
  const LIS = [['pointerdown', onClick], ['click', onClick],
    ...['play', 'playing', 'pause', 'timeupdate', 'loadstart', 'loadedmetadata', 'durationchange', 'seeked', 'ended', 'emptied', 'progress'].map((ev) => [ev, onMedia])];
  for (const [ev, fn] of LIS) document.addEventListener(ev, fn, true);
  // Medien außerhalb der Ereignisse (Leiste nach ✕ oder Einstellung wieder an): läuft schon etwas?
  const playingNow = () => [...document.querySelectorAll('audio, video')].find((a) => !a.paused);

  // ---------- Einstellungen ----------
  function settings(s) {
    s = s && typeof s === 'object' ? s : {};
    const was = st.on;
    st.on = s.playerBar !== false;
    st.theme = s.theme || 'system';
    const nav = (navigator.language || 'de').slice(0, 2);
    LANG = s.lang || (LANGS[nav] ? nav : 'de');
    if (host) host.dataset.theme = st.theme;
    if (!st.on && was) teardownBar();
    else if (st.on && !was) { const p = playingNow(); if (p) { media = p; started = true; dismissed = false; resolve(true); update(); newTrack(); } }
    texts();
  }
  // Einstellung aus: Leiste ganz entfernen
  function teardownBar() {
    started = false; update();
    host?.remove(); host = null; R = null; media = null; curSrc = '';
  }
  try {
    chrome.storage.local.get('settings').then((x) => { settings(x.settings); if (host) host.dataset.theme = st.theme; }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !alive()) return;
      if (ch.settings) settings(ch.settings.newValue);
    });
  } catch {}
})();
