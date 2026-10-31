'use strict';
// TrackPilot – Seitenleiste neben Bandcamp.
// Wertet automatisch den Release im offenen Tab aus. Alles läuft lokal; Daten liegen in chrome.storage.local.

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 86400;
const ITEMS = 50;          // neueste Käufe pro Fan (Wishlists der Fans werden nicht geladen – eine Anfrage pro Fan)
const NEW_PEEK = 20;      // so viele neueste Käufe holt eine Aktualisierung pro gefolgtem Fan, wenn der Rest schon bekannt ist
const MORE_STEP = 50;     // „Nächste 50 laden“
const FAN_STEP = 100;     // so viele Käufer pro Release werden geprüft (Einstellung: die neuesten oder die ersten); „Nächste 50“ holt die nächsten
const KEEP_MS = 6 * 3600e3;   // 0.9.41: Fan-Profile und Käuferlisten gelten 6 Stunden (aktuellere Schnittmengen, weniger fremde Daten gespeichert)
// 0.9.60: Ausnahme – große Profile der besten 300 Seelenverwandten (soulTop, mit minMatch) stimmen bei „Für Dich · Tracks“ mit;
// 0.9.66: sie bleiben dauerhaft (vorher 7 Tage), fallen sie aus den besten 300, gilt wieder die 6-Stunden-Regel
const TWIN_KEEP_N = 300, TWIN_KEEP_MS = Infinity;
const FIRST_PAGES = 30;   // „Erste Käufer“: so viele Seiten à 100 Käufer werden höchstens gelesen
const SOUL_SEEDS = 30;    // Seelenverwandte: höchstens so viele deiner Releases liest ein Durchgang (nur die Käuferliste, 2 kleine Anfragen)
const SOUL_DEEP = 15;     // ... danach bekommen höchstens so viele der besten Kandidaten ein großes Profil
const AUTO_STEP = 12;     // 0.9.53: Dauersuche – ein Durchgang startet, sobald so viele Anfragen (plus Reserve) frei sind
const DEEP_ITEMS = 200;   // ... mit ihren neuesten 200 statt 50 Käufen (Bandcamp liefert ~20 pro Abruf: etwa 10 Anfragen, siehe deepCost)
// 0.9.54: Anfragen pro großem Profil (mit Fan-ID) – gelernt aus den Durchgängen, Startwert aus gemessenen Protokollen
const DEEP_COST = 10, DEEP_MIN = 2, DEEP_MAX = 25;
const round1 = (x) => Math.round(x * 10) / 10;
const deepCost = () => Math.max(DEEP_MIN, Math.min(DEEP_MAX, S.deepCost?.v || DEEP_COST));
// Schätzung für ein Profil: ohne bekannte Fan-ID kommt die Profilseite dazu
const deepEst = (fanId) => (fanId ? deepCost() : deepCost() + 1);
// 0.9.57: Früh abbrechen – bei der Suche nach Seelenverwandten erst die neuesten 60 Käufe (3 Abrufe). Teilt der Fan davon
// weniger als 2 mit dir, hört das Profil dort auf (cut) statt alle 200 zu laden. Keine Zusatzanfrage: das sind dieselben
// ersten Seiten. Anteil der abgebrochenen (cutShare) wird gelernt wie deepCost, für die Restdauer „noch … ungeprüft“.
const PROBE_ITEMS = 60, PROBE_MIN = 2, PROBE_COST = 3;
const cutShare = () => Math.max(0, Math.min(1, S.cutShare?.v || 0));
const blendCost = () => deepCost() * (1 - cutShare()) + PROBE_COST * cutShare();
const SOUL_RESERVE = 25;  // 0.9.45: so viele Marken bleiben übrig – der Durchgang hört vorher auf, statt bis an Bandcamps Grenze zu gehen
// 0.9.47: bei kleinem gelerntem Schub ein Viertel davon (sonst bliebe für die Suche kaum etwas übrig)
const soulReserve = () => Math.max(8, Math.min(SOUL_RESERVE, Math.round(bucket().cap * 0.25)));

// Pfade auf bandcamp.com, die keine Fan-Profile sind
const RESERVED = new Set(['about', 'help', 'tag', 'tags', 'discover', 'login', 'signup', 'terms_of_use', 'privacy', 'artists',
  'fans', 'guide', 'gift_cards', 'search', 'feed', 'settings', 'cart', 'labels', 'daily', 'contact', 'fan_signup',
  'artist_signup', 'api', 'developer', 'press', 'jobs', 'policies', 'copyright', 'community', 'mobile', 'sell',
  'merch_info', 'pricing', 'features', 'logout', 'forgot_password', 'yum', 'redeem', 'music', 'artist_index']);

// timeout in ms pro Anfrage
const DEFAULTS = { delay: 45, minTotal: 10, minMatch: 2, scoutItems: 100, tagFilter: [], tagExclude: [], includeWishlist: true, fanOrder: 'new', rescanDays: 60,
  variety: true, preferNew: false, soulRefresh: 20, hideHeard: false, minFansTips: 3, minFansScouts: 3, knownArtists: true,
  concurrency: 10, timeout: 15000, lang: null, theme: 'system', playerBar: true, v: 21 };

const TAG_LISTS = ['tips', 'scouts', 'promos'];   // Tracklisten (0.9.66: ein Genre-Filter für alle, in den Einstellungen)

let S = { me: null, settings: { ...DEFAULTS }, hidden: {}, favs: {}, liked: {}, rel: {}, follow: null, tags: {}, history: [], soul: { seeds: {} }, visited: {}, taste: [], heard: {} };
// 0.9.66: Regler über der Liste – gemeinsame Releases und Fans pro Track jede ganze Zahl 2–20, Seelenverwandte für Tracks 5/10/15/20
const MATCH_MIN = 2, MATCH_MAX = 20, FANS_MIN = 2, FANS_MAX = 20, REFRESH_STEPS = [5, 10, 15, 20];
const clampInt = (v, lo, hi, def) => (v !== null && v !== '' && Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : def);
// alte Tag-Filter je Liste ({ tips: [...], ... }) oder schon global ([...]) → eine Liste, klein, ohne Doppelte
const tagUnion = (v) => [...new Set((Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v).flat() : [])
  .filter((x) => typeof x === 'string').map((x) => normTag(x)).filter(Boolean))];
const nearestStep = (v, steps, def) => (Number.isFinite(+v) && v !== null && v !== '' ? steps.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : def);
let fans = {};            // username -> Datensatz
let mySet = new Set();    // Schlüssel deiner Wishlist (+ ggf. Käufe)
let mySigs = new Set();   // „künstler|titel“ deiner Einträge – erkennt auch Track vs. Album desselben Releases
let myW = new Map(), meanW = 1;  // Gewicht je eigenem Eintrag (neu / Favorit = höher)

// Aktueller Release im offenen Tab
let cur = null;           // { url, key, title, artist, art, fans: [usernames], scanning, done, total, error }
let curTabId = null, curTabBc = false, nowTrack = '';
let pending = null;       // anderer Release im offenen Tab, der erst per Knopf ausgelesen wird: { url, title }
let releaseJob = 0, followJob = 0, loadingMe = false, dataGen = 0;   // dataGen: steigt bei „Alles löschen“/Import


// ---------- Speicher ----------
const store = {
  get: (k) => chrome.storage.local.get(k),
  set: (o) => chrome.storage.local.set(o),
  remove: (k) => chrome.storage.local.remove(k),
  clear: () => chrome.storage.local.clear(),
};

async function loadAll() {
  const all = await store.get(null);
  S.me = all.me || null;
  const st = all.settings || {};
  S.settings = { ...DEFAULTS, ...st, v: DEFAULTS.v };
  // 0.9.3: technische Werte sind nicht mehr einstellbar – immer die bewährten Vorgaben
  for (const k of ['delay', 'minTotal', 'scoutItems', 'rescanDays', 'concurrency', 'timeout']) S.settings[k] = DEFAULTS[k];
  // 0.9.66: minMatch jede ganze Zahl 2–20 (vorher 2/5/10/20), soulRefresh 5/10/15/20
  S.settings.minMatch = clampInt(st.minMatch, MATCH_MIN, MATCH_MAX, DEFAULTS.minMatch);
  S.settings.soulRefresh = nearestStep(st.soulRefresh, REFRESH_STEPS, DEFAULTS.soulRefresh);
  S.settings.preferNew = st.preferNew === true;
  S.settings.hideHeard = st.hideHeard === true;   // 0.9.59: „Gehörte ausblenden“, Standard aus
  // 0.9.66: minFans (0.9.60) getrennt für Für Dich · Tracks und Gefolgt, je 2–20; alte Einstellung gilt für beide
  const oldF = clampInt(st.minFans, FANS_MIN, FANS_MAX, DEFAULTS.minFansTips);
  S.settings.minFansTips = clampInt(st.minFansTips, FANS_MIN, FANS_MAX, oldF);
  S.settings.minFansScouts = clampInt(st.minFansScouts, FANS_MIN, FANS_MAX, oldF);
  delete S.settings.minFans;
  S.settings.knownArtists = st.knownArtists !== false;   // 0.9.60: „Bekannte Künstler bevorzugen“, Standard an
  // 0.9.66: ein Genre-Filter für alle Tracklisten – alte je Liste (tips/scouts/promos) werden zusammengelegt
  S.settings.tagFilter = tagUnion(st.tagFilter);
  S.settings.tagExclude = tagUnion(st.tagExclude).filter((x) => !S.settings.tagFilter.includes(x));
  // 0.7.6: 150 ms war zu schnell (Bandcamp sperrte dann auch deine eigenen Seitenaufrufe) – mindestens 300 ms
  S.settings.variety = st.variety !== false;   // 0.9.55: „Mehr Abwechslung“, Standard an
  delete S.settings.includePurchases;   // 0.9.41: Käufe sind die Grundlage, die Wishlist kommt per Haken dazu (Standard: an)
  delete S.settings.maxItems; delete S.settings.fast; delete S.settings.feedSize; delete S.settings.feedDays; delete S.settings.bpmRange;
  S.hidden = all.hidden || {};
  S.history = Array.isArray(all.history) ? all.history : [];   // zuletzt angehörte Lieder, neueste zuerst
  // 0.9.59: alles, was hier je lief (tk → Zeit), 180 Tage, höchstens 5000 – der Verlauf hält nur 100; übersteht „Cache leeren“
  const hd = all.heard && typeof all.heard === 'object' ? { ...all.heard } : {};
  for (const x of S.history) if (x?.tk && !(x.tk in hd)) hd[x.tk] = x.at || Date.now();
  S.heard = trimHeard(hd);
  // 0.9.56: Geschmacks-Signale (♥, Ausblenden, Überspringen) – Nutzerdaten wie liked/hidden, übersteht „Cache leeren“
  S.taste = Array.isArray(all.taste?.ev) ? all.taste.ev.filter((x) => x && x.tk && x.k) : [];
  tasteVer++;
  S.favs = all.favs || {};
  S.liked = all.liked || {};
  // 0.9.50: Profile, die du aus der Liste geöffnet hast (30 Tage)
  S.visited = Object.fromEntries(Object.entries(all.visited || {}).filter(([, at]) => Date.now() - at < 30 * 864e5));
  S.rel = all.rel || {};
  if ((st.v || 0) < 13) { S.rel = {}; store.set({ rel: {} }); }   // 0.9.6 hat bei Sperren unvollständige Fan-Listen gemerkt
  S.follow = all.follow || null;
  S.followed = all.followed || null;   // { at, users } – wem du auf Bandcamp folgst (für die grüne Markierung)
  // 0.9.61: Listen von vor 0.9.61 waren oft unvollständig (nur die ersten 45) – beim Öffnen gleich neu abfragen
  if (S.followed && (S.followed.v || 0) < 64) S.followed = { ...S.followed, at: 0 };   // 0.9.64: alte Liste ohne „followeers“ einmal neu holen
  S.tags = all.tags || {};
  tagVer++;
  // Seelenverwandte: die gefundenen Fans (dauerhaft) unter 'soul', die Käufernamen deiner Releases (30 Tage) einzeln unter
  // 'seed:'+Release (0.9.53; bis 0.9.52 lag alles unter 'soul' und wird einmal umgezogen)
  const { seeds: oldSeeds, ...soulRest } = all.soul && typeof all.soul === 'object' ? all.soul : {};
  S.soul = { ...soulRest, seeds: {} };
  for (const [k, v] of Object.entries(all)) if (k.startsWith('seed:')) S.soul.seeds[k.slice(5)] = v;
  if (oldSeeds) {
    for (const [k, v] of Object.entries(oldSeeds)) S.soul.seeds[k] ??= v;
    await store.set({ soul: soulMeta(), ...Object.fromEntries(Object.entries(S.soul.seeds).map(([k, v]) => ['seed:' + k, v])) });
  }
  if (all.freshShare) freshShare = all.freshShare;
  // 0.9.14: Tempo 45 ms plus gelernter Marken-Eimer (Schub + Nachschub), siehe bucket()
  S.bucket = (st.v || 0) >= 21 && all.reqBucket?.until > Date.now() ? all.reqBucket : null;
  S.deepCost = Number.isFinite(all.deepCost?.v) ? all.deepCost : null;   // 0.9.54: Live-Wert wie reqBucket, übersteht „Cache leeren“
  S.cutShare = Number.isFinite(all.cutShare?.v) ? all.cutShare : null;   // 0.9.57: ebenso
  if (all.reqMeasured) store.remove('reqMeasured');   // 0.9.40: Messen entfernt – gemessen 56/min, bei der Suche gingen nur ~36/min
  if (S.bucket && S.bucket.rate < rateFloor()) S.bucket = { ...S.bucket, rate: rateFloor() };   // 0.9.25: früher gelernte 11/min waren zu pessimistisch
  // 0.9.38: ältere Versionen haben sich bis 120/min hochgetastet – nie über die Messung bzw. ohne Messung über 30/min
  const rMax = 30, cMax = 170;
  if (S.bucket && (S.bucket.rate > rMax || S.bucket.cap > cMax)) S.bucket = { ...S.bucket, rate: Math.min(S.bucket.rate, rMax), cap: Math.min(S.bucket.cap, cMax) };
  if ((st.v || 0) >= 21 && Number.isFinite(all.reqTokens?.t)) { tokens = Math.max(0, all.reqTokens.t); refillAt = all.reqTokens.at; }   // 0.9.28: 0.9.25–0.9.27 konnten durchs Hören ins Minus zählen
  pace = null;
  fans = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith('fan:')) fans[k.slice(4)] = v;
  buildMine();          // 0.9.60: vor pruneOld – die besten 300 (soulTop zählt mit mySet) behalten ihr Profil (0.9.66: dauerhaft)
  computeMyWeights();
  pruneOld();
  const had = Object.keys(all).some((k) => k !== 'welcomed');   // 0.9.68: nur „Begrüßung gesehen“ ist noch kein alter Datenstand
  if ((st.v || 0) < 8 && had) await migrate();
  else if ((st.v || 0) < 21 && had) { await store.set({ settings: S.settings }); await store.remove(['learnedDelay', 'paceFloor', 'reqBudget', 'reqBucket']); }
  // Neu installiert oder „Alles löschen“: Version gleich merken, sonst hält das nächste Öffnen die eigenen Daten für alt
  // (Release-Liste, Tracksuche und Limit-Stand würden verworfen)
  else if (!all.settings) await store.set({ settings: S.settings });
}

// Ab 0.7: pro Fan nur die neuesten 50 Käufe, Warteschlange und Feed entfallen
async function migrate() {
  for (const f of Object.values(fans)) trimFan(f);
  await saveAllFans();
  await store.remove(['queue', 'done', 'feed', 'feedAt', 'feedPrev', 'follow']);
  await store.set({ settings: S.settings });
  S.follow = null;
  log(t('Daten umgestellt: pro Fan nur noch die neuesten 50 Käufe.'));
}
function trimFan(f) {
  if (!f.keys || f.error) return;
  const nc = f.nc ?? f.keys.length;                         // Käufe stehen vorne
  const had = f.keys.length;
  const idx = f.keys.slice(0, nc).map((k, i) => i).sort((a, b) => (f.dt?.[b] || 0) - (f.dt?.[a] || 0)).slice(0, ITEMS)
    .sort((a, b) => a - b);
  f.keys = idx.map((i) => f.keys[i]);
  f.dt = idx.map((i) => f.dt?.[i] || 0);
  f.nc = f.total = f.keys.length;
  if (f.meta) { const keep = new Set(f.keys); f.meta = Object.fromEntries(Object.entries(f.meta).filter(([k]) => keep.has(k))); }
  if (had && !f.keys.length) f.scannedAt = 0;               // hatte nur Wishlist-Daten: beim nächsten Mal neu prüfen
}
let popVer = 0;   // 0.9.55: steigt, wenn sich gespeicherte Profile ändern (Zwischenspeicher von popIndex)
const saveFan = (u) => { popVer++; return store.set({ ['fan:' + u]: fans[u] }); };
const saveAllFans = () => (popVer++, store.set(Object.fromEntries(Object.entries(fans).map(([u, f]) => ['fan:' + u, f]))));

// ---------- Netzwerk: gedrosselt, mit Zeitlimit und Neuversuch ----------
// Selbstlernendes Tempo: knapp unter Bandcamps Grenze bleiben statt dagegen zu laufen.
// pace = Abstand zwischen zwei Anfragen in ms (fest); dazu das gelernte Minutenlimit.
let lastReq = 0, pauseUntil = 0, yieldUntil = 0, pace = null, strikes = 0, lastStrike = 0;
// Bandcamp arbeitet wie ein Eimer mit Marken (Protokoll vom 4.10.: erste Sperre nach ~170 Anfragen, danach auch bei
// viel weniger Anfragen weiter Sperren): ein Schub geht durch, danach füllt sich der Eimer nur langsam wieder auf.
// Die Leiste rechnet das nach: cap = Schub, rate = Nachschub pro Minute. Beides wird bei Sperren nachgelernt (24 h).
const BUCKET = { cap: 150, rate: 30 };
const RATE_MIN = 20;   // Bandcamp lief in allen Protokollen mit mindestens ~23 Anfragen pro Minute nach
let blockedUntil = 0;   // nach einer Sperre: bis dahin gar nicht mehr fragen, die laufende Suche bricht ab
let tokens = null, refillAt = Date.now(), spent = 0;
// Was Bandcamp seit der letzten Sperre angenommen hat: zwischen zwei Sperren war sein Eimer zweimal leer, also ist das
// genau der Nachschub, der der Suche bleibt (dein eigenes Surfen und Hören ist darin schon abgezogen, nicht mitgezählt)
let okN = 0, emptyAt = 0, emptyN = 0, brakeN = 0;   // brakeN: Zahl der Sperren (eine Marke aus der Zeit vor einer Sperre wird nicht zurückgelegt)
const curPace = () => (pace ??= S.settings.delay);
// Untergrenze für den gelernten Nachschub
const rateFloor = () => RATE_MIN;
const bucket = () => (S.bucket?.until > Date.now() ? S.bucket : BUCKET);
function refill() {
  const now = Date.now(), b = bucket();
  tokens = Math.min(b.cap, (tokens ?? b.cap) + ((now - refillAt) * b.rate) / 60000);
  refillAt = now;
}

function brake(status, retryAfter) {
  const now = Date.now();
  if (now < Math.max(pauseUntil, blockedUntil)) return;   // parallele oder verspätete Anfragen lösen nur eine Bremsung aus
  strikes = now - lastStrike < 120000 ? strikes + 1 : 1;
  lastStrike = now;
  const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(60000, 10000 * 2 ** (strikes - 1));
  pauseUntil = now + wait;
  refill();
  // Weiterfragen hält die Sperre nur am Leben: bis genug Marken nachgelaufen sind, geht keine Anfrage mehr raus
  blockedUntil = now + Math.max(wait, (10 * 60000) / Math.max(rateFloor(), bucket().rate));
  const b = { ...bucket() }, left = tokens;
  // Zweite Sperre kurz nach der ersten (der Eimer kann dazwischen nie voll gewesen sein): was seitdem durchging, ist
  // der echte Nachschub – genau gemessen statt geschätzt (Protokoll 5.10.: gemessen 56/min, bei der Suche gingen ~36/min)
  const dt = now - emptyAt, got = okN - emptyN;
  const seen = emptyAt && dt >= 20000 && (dt * b.rate) / 60000 < b.cap ? Math.floor((got * 60000) / dt) : null;
  if (seen != null) b.rate = Math.max(rateFloor(), Math.min(b.rate, seen));   // eine Sperre macht nie schneller
  // Sonst: bei der Sperre ist Bandcamps Eimer leer. War laut Rechnung noch mehr als die Hälfte übrig, ist der Schub
  // kleiner als gedacht – sonst läuft der Nachschub langsamer nach als angenommen.
  // 0.9.46: Steht der Nachschub schon auf dem Minimum, lernte eine Sperre bisher nichts (bzw. nur 30 % vom Schub) – Protokoll 6.10.:
  // jede Suche lief am Ende in dieselbe Sperre. Dann sinkt der Schub gleich auf das, was seit vollem Eimer durchging, mit 10 % Luft.
  else if (b.rate <= rateFloor() && left >= 5) b.cap = Math.max(30, Math.floor((b.cap - left) * 0.9));
  else if (left > b.cap * 0.5) b.cap = Math.max(30, Math.floor(b.cap * 0.7), Math.floor((b.cap - left) * 0.9));   // eine Sperre senkt den Schub höchstens um 30 %
  else b.rate = Math.max(rateFloor(), Math.floor(b.rate * 0.85));
  emptyAt = now; emptyN = okN; brakeN++;
  S.bucket = { cap: b.cap, rate: b.rate, until: now + 864e5 };
  store.set({ reqBucket: S.bucket });
  tokens = 0;
  saveTokens();
  if (seen != null) log(t('Bandcamp bremst (HTTP {status}) – Pause {wait} s; seit der letzten Sperre gingen {n} Anfragen in {s} s durch, also {seen} pro Minute. Die Suche rechnet mit {rate} pro Minute (gilt 24 h).', { status, wait: Math.round(wait / 1000), n: got, s: Math.round(dt / 1000), seen, rate: b.rate }));
  else log(t('Bandcamp bremst (HTTP {status}) – Pause {wait} s; gelernt: Schub {cap}, danach {rate} Anfragen pro Minute (gilt 24 h).', { status, wait: Math.round(wait / 1000), cap: b.cap, rate: b.rate }));
  if (cur?.scanning || scoutsRunning || soulRunning) setStatus(t('Bandcamp bremst gerade – die Suche hält an. Oben läuft die Zeit, bis es weitergeht.'));
}

// Lief eine Suche ohne Sperre durch, war die Schätzung zu vorsichtig: langsam wieder mutiger werden (bis zur Vorgabe-Obergrenze)
// Nur wenn die Suche den Eimer laut Rechnung fast geleert hat, sagt „keine Sperre“ etwas über die Grenze aus.
// Ohne Messung nie über 30/min (so viel lief in gemessenen Protokollen höchstens nach).
let minTok = Infinity;   // niedrigster Stand während der laufenden Suche
function bucketOk(used) {
  const low = minTok;
  minTok = Infinity;
  if (used < 20 || Date.now() - lastStrike < 120000 || low > bucket().cap * 0.2) return;
  const b = bucket();
  const capMax = 170, rateMax = 30;
  S.bucket = { cap: Math.min(capMax, b.cap + 3), rate: Math.min(rateMax, Math.max(b.rate + 1, Math.round(b.rate * 1.05))), until: Date.now() + 864e5 };   // +5 %: tastet sich nur sanft an die Grenze
  store.set({ reqBucket: S.bucket });
}

// Sekunden, bis n Anfragen ohne Bremsung am Stück möglich sind
function secondsFor(n) {
  refill();
  const b = bucket(), need = Math.min(Math.ceil(n * 1.15), b.cap * 0.95) - tokens;   // 15 % Luft, falls die Schätzung knapp ist
  return Math.max(Math.ceil((blockedUntil - Date.now()) / 1000), need <= 0 ? 0 : Math.ceil((need * 60) / b.rate));
}
// Anfragen, die „Weitere Fans prüfen“ voraussichtlich braucht: noch ungeprüfte Fans + Käuferliste
// Anfragen für einen neuen Release: viele seiner Fans sind meist schon geprüft (60 Tage gemerkt) und kosten nichts.
// Ist die Fan-Liste schon bekannt, wird genau gezählt, sonst mit dem gelernten Anteil neuer Fans geschätzt.
let freshShare = 0.7;
// Gilt ein Fan als frisch geprüft (genau wie in scanFanNow)? Auch eine leere Sammlung ist „geprüft“.
// 0.9.60: Fehler 1 h, große Profile der besten 300 Seelenverwandten dauerhaft (0.9.66, vorher 7 Tage), sonst 6 Stunden
const fanKeep = (u, f = fans[u]) => (f.error ? 3600e3 : f.deep && twinKeep().has(u) ? TWIN_KEEP_MS : KEEP_MS);
const fanFresh = (u) => { const f = fans[u]; return !!f && Date.now() - f.scannedAt < fanKeep(u, f); };
// Anfragen für einen Fan: 0 wenn frisch geprüft, 1 mit bekannter Fan-ID, 2 wenn erst seine Profilseite geladen werden muss
const scanCost = (u, rel) => (fanFresh(u) ? 0 : fans[u]?.fanId || rel?.ids?.[u] ? 1 : 2);
const fanOrder = () => (S.settings.fanOrder === 'first' ? 'first' : 'new');
const relFresh = (rel) => !!rel && (rel.ord || 'new') === fanOrder() && Date.now() - rel.at < KEEP_MS;
function releaseCost(url) {
  const rel = S.rel[url];
  const list = relFresh(rel) ? rel.fans.slice(0, FAN_STEP) : null;
  if (list?.length) return list.reduce((n, u) => n + scanCost(u, rel), 0);
  return 3 + (fanOrder() === 'first' ? 10 : 0) + Math.ceil(FAN_STEP * freshShare);
}
function learnFresh(fresh, checked) {
  if (checked < 20) return;
  freshShare = Math.min(1, Math.max(0.2, freshShare * 0.6 + (fresh / checked) * 0.4));
  store.set({ freshShare });
}
function moreCost() {
  const rel = S.rel[cur.url], next = cur.fans.slice(cur.limit, cur.limit + MORE_STEP);
  return (cur.more ? Math.ceil((MORE_STEP - next.length) * freshShare) + 3 : 0) + next.reduce((n, u) => n + scanCost(u, rel), 0);
}
// Noch offene Fans im geprüften Bereich und was sie kosten
const openFans = () => (cur ? cur.fans.slice(0, cur.limit).filter((u) => !fanFresh(u)) : []);
const fmtCount = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
// Ein Knopf oben für alle Reiter: „Suche starten“ bzw. bei den Fanvorschlägen danach „Nächste 50 laden“
let tipsOn = false, scoutsRunning = false, soulOn = false, soulRunning = false;
// 0.9.53: Dauersuche bei „Für Dich“ (soulAuto) und einmaliges Auffrischen beim Öffnen von „Für Dich · Tracks“ (tracksAuto)
const soulAuto = { on: false, t0: 0, tick: 0, away: 0, req: 0, neu: 0, deep: 0, cut: 0, passes: 0, next: 0, brk: 0, blk: 0 };
let tracksAuto = false, shownTracks = false;
// 0.9.48: Reiter „Aktueller Track“ (match), „Für Dich“ (soul), „Gefolgt“ (scouts); in den ersten beiden wählt der Umschalter
// Fans oder Tracks. activeTab() liefert weiter die Ansicht: 'match' (Fans), 'tips' (Tracks), 'scouts' oder 'promos' (0.9.58).
let realTab = 'match';
const TABS = ['match', 'soul', 'scouts', 'promos'];
const tabView = { match: 'fans', soul: 'fans' };
const activeTab = () => (realTab === 'scouts' || realTab === 'promos' ? realTab : tabView[realTab] === 'tracks' ? 'tips' : 'match');
// 0.9.58: noch kein Reiter gemerkt (neu installiert, „Alles löschen“): kleine Sammlung → „Aktueller Track“, sonst „Für Dich“
const START_BIG = 50;
const startTab = () => ((S.me?.keys?.length || 0) < START_BIG ? 'match' : 'soul');
// 0.9.68: ohne eigene Sammlung – was als Nächstes zu tun ist (Setup-Karte oben)
const NEED_ME = 'Trag zuerst oben deinen Bandcamp-Benutzernamen ein und drück auf „Wishlist laden“.';
const WAIT_TITLE = () => t('Bandcamp lässt nur eine begrenzte Zahl Anfragen zu – sobald die Zeit abgelaufen ist, läuft die Suche mit voller Geschwindigkeit ohne Sperre durch');
// Startknopf, der erst freigegeben wird, wenn die Suche (cost Anfragen) ohne Sperre durchlaufen kann
function gated(label, cost, run, short = t('Suche')) {
  const sec = secondsFor(cost);
  return sec ? { label: t('{what} in {time}', { what: short, time: fmtCount(sec) }), title: WAIT_TITLE(), wait: sec } : { label, run };
}
// Knopf für den offenen Release (Fanvorschläge und Trackvorschläge): null = nichts zu tun
function releaseState() {
  if (pending) return gated(t('Suche starten'), releaseCost(pending.url), () => readRelease(pending.url));
  if (!cur) return null;
  const rel = S.rel[cur.url], cont = continueState();
  if (cont) return cont;
  if (cur.total > cur.limit || cur.more) {
    return gated(t('Nächste {n} laden', { n: MORE_STEP }), moreCost(), () => openRelease(cur.url, cur.limit + MORE_STEP), t('Nächste {n}', { n: MORE_STEP }));
  }
  // Käuferliste älter als 3 Tage (z. B. nach dem Wiederherstellen): neu lesen
  if (!relFresh(rel)) return gated(t('Suche starten'), releaseCost(cur.url), () => openRelease(cur.url, cur.limit));
  return null;
}
// Sperre, Fehler oder unvollständige Käuferliste: denselben Release nochmal bzw. weiter prüfen
function continueState() {
  if (!cur || !(cur.blocked || cur.error || cur.partial)) return null;
  const rel = S.rel[cur.url], open = openFans();
  const cost = (relFresh(rel) ? 0 : 3) + open.reduce((n, u) => n + scanCost(u, rel), 0);
  return open.length || cur.error || cur.partial ? gated(t('Weiter prüfen'), Math.max(1, cost), () => openRelease(cur.url, cur.limit), t('Weiter')) : null;
}
// Hat Bandcamp eine Suche gebremst, geht sie von selbst weiter, sobald der Eimer für den Rest reicht – höchstens
// AUTO_MAX-mal in Folge, danach wieder per Knopf. Ist links schon ein anderer Release offen, wartet sie.
const AUTO_MAX = 3;
let autoGo = null;   // { url, limit, n }
setInterval(() => {
  if (!autoGo || pending || cur?.scanning || scoutsRunning || soulRunning) return;
  if (cur?.url !== autoGo.url || cur.limit !== autoGo.limit || !cur.blocked) { autoGo = null; return; }
  const st = continueState();
  if (!st?.run) return;
  autoGo.n++;
  st.run();
}, 1000);
// „Suche starten“ für die gefolgten Fans (Gefolgt, und Promos ohne frische Daten)
const scoutsGate = () => gated(t('Suche starten'), (S.followed?.users.length || Object.keys(S.follow?.fans || {}).length || 100) + 3, refreshScouts);
function actionState() {
  const tab = activeTab();
  // Nie zwei Suchen gleichzeitig: der Startknopf rechnet nur mit dem, was gerade im Eimer ist
  if (cur?.scanning || scoutsRunning || soulRunning) return { label: t('Suche läuft …'), busy: true };
  // 0.9.68: ohne eigene Sammlung gibt es nichts zu vergleichen – Knopf gesperrt, der Tooltip sagt, was zu tun ist
  if (!S.me && tab !== 'promos' && !soulOn) return { label: t('Suche starten'), title: t(NEED_ME) };
  if (tab === 'scouts') return scoutsGate();
  if (tab === 'promos') return promoAction();
  if (soulOn) return soulState();   // Fan- und Trackvorschläge über alle deine Releases
  const st = releaseState();
  if (tab === 'tips') {
    // Trackvorschläge beruhen auf den Fans des offenen Releases: der Knopf startet bzw. setzt deren Suche fort
    if (!tipsOn && !pending && cur) return { label: t('Suche starten'), run: () => { tipsOn = true; renderTips(); saveView(); } };
    if (st?.run) { const run = st.run; st.run = () => { tipsOn = true; run(); }; }
    if (st) return st;
  } else if (st) return st;
  const done = cur && S.me;   // ohne Wishlist wurde kein Fan geprüft
  return { label: done ? '✓ ' + t('Alle Fans geprüft') : t('Suche starten'), title: t(done ? 'Alle Fans dieses Releases sind geprüft' : cur ? NEED_ME : 'Öffne links ein Album oder einen Track auf Bandcamp') };
}
// Gesperrt heißt hier aria-disabled statt disabled: der Knopf bleibt per Tastatur erreichbar und sein title (warum warten?) lesbar.
// Beim Warten füllt sich der Knopf bis zur Freigabe.
function renderAction() {
  const b = $('#btnAction'), st = actionState();
  b.textContent = st.label;
  b.setAttribute('aria-disabled', String(!st.run));
  b.title = st.title || '';
  b._run = st.run;
  b.dataset.state = st.run ? 'ready' : st.wait ? 'wait' : st.busy ? 'busy' : 'idle';
  const k = activeTab();
  if (b._wk !== k) { b._w0 = 0; b._wk = k; }   // jeder Tab hat seine eigene Wartezeit
  if (st.wait) { if (!(b._w0 >= st.wait)) b._w0 = st.wait; b.style.setProperty('--p', String(1 - st.wait / b._w0)); }
  else { b._w0 = 0; b.style.removeProperty('--p'); }
}
setInterval(() => { if ($('#btnAction')) renderAction(); }, 1000);

// Pause, solange du selbst eine Bandcamp-Seite lädst – endet, sobald die Seite fertig ist (spätestens nach 5 s)
function yieldToUser() { yieldUntil = Math.max(yieldUntil, Date.now() + 5000); }
function userDone() { yieldUntil = Math.min(yieldUntil, Date.now() + 300); }

// Wartet auf das nächste freie Zeitfenster; eine Pause, die währenddessen kommt oder früher endet, wird berücksichtigt
async function waitTurn(low = false) {
  for (;;) {
    if (Date.now() < blockedUntil) return;   // request() bricht dann ab – ohne eine Marke zu verbrauchen
    const hold = Math.max(pauseUntil, yieldUntil);
    if (Date.now() < hold) { await sleep(Math.min(200, hold - Date.now())); continue; }
    // Marke nötig: ist der Eimer leer, warten bis die nächste nachgelaufen ist
    refill();
    // Hintergrundarbeit (Tags) nutzt nur Marken, die sonst überlaufen würden – sonst bliebe der Startknopf
    // einer großen Suche ewig gesperrt
    if (low && tokens < bucket().cap - 1) { await sleep(1000); continue; }
    // Keine Drosselung während einer Suche: es wird nur mitgezählt. Gebremst wird vorher – der Knopf oben
    // lässt eine Suche erst zu, wenn der Eimer für sie reicht (siehe actionState).
    // War die Schätzung zu knapp, kurz auf die nächste Marke warten statt in eine Sperre zu laufen
    if (tokens < 1) { await sleep(Math.min(3000, ((1 - tokens) * 60000) / bucket().rate)); continue; }
    tokens -= 1; sentN++;
    const ep = brakeN;
    if (tokens < minTok) minTok = tokens;
    if (++spent % 5 === 0) saveTokens();   // Stand merken, falls die Leiste neu geöffnet wird (oder in einem zweiten Fenster offen ist)
    const slot = Math.max(Date.now(), lastReq + curPace());
    lastReq = slot;
    if (slot > Date.now()) await sleep(slot - Date.now());
    if (Date.now() >= Math.max(pauseUntil, yieldUntil) && Date.now() >= blockedUntil) return;
    sentN--;
    if (ep === brakeN) tokens += 1;   // Anfrage ging doch nicht raus (Pause kam dazwischen): Marke zurück – nach einer Sperre nicht, da ist der Eimer sicher leer (sonst öffnet der Knopf zu früh)
  }
}
// Ist die Leiste in zwei Fenstern offen, teilen sich beide denselben Eimer: jede meldet ihren Stand, wie viele Anfragen
// sie insgesamt geschickt hat und eine Sperre. Die andere zieht ab, was seit der letzten Meldung dazukam, und nimmt den kleineren Stand.
const WIN = Math.random().toString(36).slice(2);
let sentN = 0;
const seenN = {};
const saveTokens = () => store.set({ reqTokens: { t: tokens, at: Date.now(), w: WIN, n: sentN, blk: blockedUntil } });
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c.reqBucket && c.reqBucket.newValue?.until > Date.now()) S.bucket = c.reqBucket.newValue;   // im anderen Fenster gelernt
  if (Number.isFinite(c.deepCost?.newValue?.v)) S.deepCost = c.deepCost.newValue;
  if (Number.isFinite(c.cutShare?.newValue?.v)) S.cutShare = c.cutShare.newValue;
  if (Array.isArray(c.history?.newValue)) S.history = c.history.newValue;   // im anderen Fenster gehört
  if (Array.isArray(c.taste?.newValue?.ev) && c.taste.newValue.w !== WIN) { S.taste = c.taste.newValue.ev; tasteVer++; }
  const v = c.reqTokens?.newValue;
  if (!v || v.w === WIN || tokens == null) return;
  refill();
  const b = bucket();
  if (v.w) { const d = v.n - (seenN[v.w] ?? v.n); seenN[v.w] = v.n; if (d > 0) { tokens -= d; okN += d; } }
  tokens = Math.max(0, Math.min(tokens, b.cap, v.t + ((Date.now() - v.at) * b.rate) / 60000));
  if (v.blk > blockedUntil) blockedUntil = v.blk;
});
window.addEventListener('pagehide', () => { if (tokens != null) saveTokens(); });
// Bandcamps Limit ist Live-Zustand, keine Nutzerdaten: übersteht Import und „Alles löschen“ (0.9.54: auch die gelernten
// Anfragen pro Profil). Hat diese Leiste noch nicht gerechnet, gilt der gespeicherte Stand (z. B. aus dem anderen Fenster).
async function keepLimit() {
  if (tokens == null) {
    const v = (await store.get('reqTokens')).reqTokens;
    if (Number.isFinite(v?.t)) { tokens = Math.max(0, v.t); refillAt = v.at; if (v.blk > blockedUntil) blockedUntil = v.blk; }
  }
  return { t: tokens, at: refillAt, dc: S.deepCost, cs: S.cutShare };
}
function restoreLimit(lim) {
  if (lim?.t != null) { tokens = lim.t; refillAt = lim.at; saveTokens(); }
  if (lim?.dc) { S.deepCost = lim.dc; store.set({ deepCost: lim.dc }); }
  if (lim?.cs) { S.cutShare = lim.cs; store.set({ cutShare: lim.cs }); }
}

const blockedError = () => Object.assign(new Error(t('Bandcamp-Sperre')), { blocked: true });
// 0.9.53: Anfragen der Seelenverwandten-Suche zählen (tally), nach Art – das Protokoll zeigt sie pro Durchgang. Jeder
// Versuch, der wirklich an Bandcamp rausgeht, zählt einmal; Anfragen anderer Teile der Leiste zählen nicht mit.
// 0.9.54: got = erhaltene Käufe aus den Kauflisten (keine Anfrage, nur fürs Protokoll „Käufe pro Abruf“)
const newTally = () => ({ buyers: 0, items: 0, pages: 0, other: 0, got: 0 });
const tallyReq = (x) => x.buyers + x.items + x.pages + x.other;
const addTally = (to, x) => { for (const k of Object.keys(x)) to[k] += x[k]; };
const reqKind = (url) => (url.includes('/api/tralbumcollectors/') ? 'buyers' : url.includes('/api/fancollection/') ? 'items'
  : /^https:\/\/bandcamp\.com\/[^/?#]+\/?$/.test(url) ? 'pages' : 'other');
async function request(url, { low, tally, ...opts } = {}, as = 'text', attempt = 0) {
  if (Date.now() < blockedUntil) throw blockedError();
  await waitTurn(low);   // Zeitfenster reservieren – funktioniert auch bei parallelen Anfragen
  if (Date.now() < blockedUntil) throw blockedError();
  if (tally) tally[reqKind(url)]++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), S.settings.timeout);
  try {
    const res = await fetch(url, { credentials: 'include', ...opts, signal: ctrl.signal });
    if (res.status !== 429) okN++;
    if (res.status === 429) { brake(429, +res.headers.get('Retry-After') || 0); throw blockedError(); }   // nie gleich nochmal fragen
    if (res.status >= 500) {   // Serverfehler sind keine Sperre: kurz warten und nochmal, ohne das Limit neu zu lernen
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); return request(url, { low, tally, ...opts }, as, attempt + 1); }
      throw new Error('HTTP ' + res.status);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = as === 'json' ? await res.json() : await res.text();
    return body;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (attempt < 2) { await sleep(1500); return request(url, { low, tally, ...opts }, as, attempt + 1); }
      throw new Error(t('Zeitüberschreitung'));
    }
    if (!e.blocked && !/^HTTP/.test(e.message) && attempt < 2) { await sleep(3000); return request(url, { low, tally, ...opts }, as, attempt + 1); }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const getHtml = async (url, low = false, tally) => new DOMParser().parseFromString(await request(url, { low, tally }), 'text/html');
const postJson = (url, body, tally) => request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), tally,
}, 'json');
// 0.9.53: Fehler, die sich nicht von selbst geben (gelöscht, privat, kein Fan-Profil) – anders als Zeitüberschreitung,
// Serverfehler oder fehlendes Netz
const permError = (msg) => Object.assign(new Error(msg), { perm: true });
const isPerm = (e) => !!e.perm || /^HTTP 4\d\d/.test(e.message || '');

// ---------- Bandcamp-Daten ----------
// Profilseite: nur, wenn die Fan-ID nicht anders bekannt ist (groß und langsam)
async function fanPage(username, tally) {
  const doc = await getHtml(`https://bandcamp.com/${encodeURIComponent(username)}`, false, tally);
  const blob = doc.querySelector('#pagedata')?.getAttribute('data-blob');
  if (!blob) throw permError(t('keine Profildaten'));
  const data = JSON.parse(blob);
  const fanId = data.fan_data?.fan_id;
  if (!fanId) throw permError(t('keine fan_id (kein Fan-Profil?)'));
  return { fanId, name: data.fan_data?.name || username, data };
}

function keyOf(it) {
  const id = it.tralbum_id ?? it.item_id;
  if (id == null) return null;
  const t = it.tralbum_type || (String(it.item_type || '').startsWith('t') ? 't' : 'a');
  return t + id;
}
// Zeitpunkt, an dem der Eintrag in Sammlung/Wishlist kam (Sekunden)
function dateOf(it) {
  for (const v of [it.added, it.purchased, it.updated]) {
    if (!v) continue;
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    if (!isNaN(t)) return Math.round(t / 1000);
  }
  const m = String(it.token || '').match(/^(\d{9,10}):/);
  return m ? +m[1] : null;
}
// [Titel, Künstler, Link, Featured-Track-ID, dessen Titel, vom Fan gewählt?, Datum, Cover-ID, Album-ID bei Einzeltracks]
// 0.9.58: dahinter eine 1, wenn Bandcamp den Kauf als Pre-Order meldet (sonst fehlt der Eintrag – alte Daten bleiben gültig)
const metaOf = (it) => {
  const m = [it.item_title || it.album_title || '', it.band_name || '', it.item_url || it.tralbum_url || '',
    it.featured_track ?? null, it.featured_track_title || '', it.featured_track_is_custom ? 1 : 0, dateOf(it),
    it.item_art_id ?? it.art_id ?? null, it.album_id ?? null];
  if (it.is_preorder) m.push(1);
  return m;
};

function cacheItems(data, kind) {
  const out = new Map();
  const cache = data?.item_cache?.[kind];
  if (cache) for (const it of Object.values(cache)) { const k = keyOf(it); if (k) out.set(k, metaOf(it)); }
  return out;
}

// kind: 'collection' oder 'wishlist'; data (Profilseite) ist optional
// probe (0.9.57): sobald die neuesten PROBE_ITEMS da sind und davon weniger als PROBE_MIN in deiner Liste stehen, aufhören
// (out.cut) – nur wenn noch mehr da wäre
async function fanItems(fanId, data, kind, max, tally, probe = false) {
  const out = cacheItems(data, kind);
  const info = data?.[kind + '_data'];
  let token = (out.size && info?.last_token) || '9999999999::a::';
  if (info?.item_count != null && out.size >= info.item_count) return out;
  for (let page = 0; page < 1000 && out.size < max; page++) {
    if (probe && out.size >= PROBE_ITEMS) {
      probe = false;
      let hit = 0;
      for (const k of out.keys()) if (mySet.has(k)) hit++;
      if (hit < PROBE_MIN) { out.cut = true; break; }
    }
    let res;
    try {
      res = await postJson(`https://bandcamp.com/api/fancollection/1/${kind}_items`,
        { fan_id: fanId, older_than_token: token, count: Math.min(100, Math.max(10, max - out.size)) }, tally);
    } catch (e) {
      if (e.blocked) throw e;
      out.failed = e.message;
      break;
    }
    const items = res.items || [];
    if (tally) tally.got += items.length;
    for (const it of items) { const k = keyOf(it); if (k) out.set(k, metaOf(it)); }
    if (!res.more_available || !items.length || !res.last_token || res.last_token === token) break;
    token = res.last_token;
  }
  return out;
}

// Die neuesten max Käufe eines Fans – bis 100 ist das eine einzige Anfrage. Ergebnis: [[Schlüssel, Meta, 'c'], …]
async function newestItems(fanId, data, max = ITEMS, tally, probe = false) {
  const col = await fanItems(fanId, data, 'collection', max, tally, probe);
  if (!col.size && col.failed) throw new Error(col.failed);
  const out = [...col].map(([k, m]) => [k, m, 'c']).sort((a, b) => (b[1][6] || 0) - (a[1][6] || 0)).slice(0, max);
  if (col.failed) out.partial = true;   // eine spätere Seite ging schief: nur ein Teil der Käufe
  if (col.cut) out.cut = true;          // 0.9.57: früh abgebrochen (kaum Überschneidung bei den neuesten)
  return out;
}

function userFromHref(h) {
  if (!h) return null;
  const m = h.match(/^https?:\/\/bandcamp\.com\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  return m[1];
}

// Liefert die Unterstützer eines Releases – wenn möglich gleich mit Fan-ID und Profilbild
// onMeta(Release-Infos) kommt zuerst, onUsers(neue Fans) nach jeder gelesenen Seite – so kann die Prüfung sofort starten
// max: aufhören, sobald so viele Fans gefunden sind (more = es gäbe noch weitere)
// first: die ganze Käuferliste lesen (höchstens FIRST_PAGES Seiten) und die frühesten Käufer zuerst liefern
async function supporters(albumUrl, { onMeta = () => {}, onUsers = () => {}, max = Infinity, tabId = null, first = false } = {}) {
  // Ist der Release links offen, wird die schon geladene Seite gelesen statt sie ein zweites Mal herunterzuladen
  let doc = null;
  if (tabId != null) {
    try {
      const m = await chrome.tabs.sendMessage(tabId, { type: 'getHtml' });
      if (m?.url === albumUrl && m.html) doc = new DOMParser().parseFromString(m.html, 'text/html');
    } catch { /* Tab nicht erreichbar: normal laden */ }
  }
  doc ??= await getHtml(albumUrl);
  let tralbum = null;
  try { tralbum = JSON.parse(doc.querySelector('script[data-tralbum]')?.getAttribute('data-tralbum') || 'null'); } catch { /* egal */ }
  const key = tralbum?.id ? (tralbum.item_type === 'track' ? 't' : 'a') + tralbum.id : null;
  const meta = { key, title: tralbum?.current?.title || doc.title, artist: tralbum?.artist || '', art: tralbum?.art_id || null };
  onMeta(meta);
  const users = new Map();
  let fresh = [];
  const flush = () => { if (fresh.length && !first) onUsers(fresh); fresh = []; };
  let seq = 0, grp = 2;   // grp: 2 = Links auf der Seite (die neuesten), 0 = Käufer, 1 = Käufer mit Rezension
  const add = (u, fanId, name, img, tok) => {
    if (!u) return;
    const e = users.get(u) || { u, n: seq++, g: grp };
    if (tok && e.ts == null) { const ts = parseInt(String(tok), 10); if (ts > 1e9) e.ts = ts; }
    if (fanId) e.fanId = fanId;
    if (name) e.name = name;
    if (img) e.img = img;
    if (!users.has(u)) fresh.push(e);
    users.set(u, e);
  };

  const scoped = doc.querySelectorAll('.collected-by a, .collectors a, #collectors a, a.pic, a.fan');
  const anchors = scoped.length ? scoped : doc.querySelectorAll('a');
  for (const a of anchors) add(userFromHref(a.getAttribute('href')));
  flush();

  let more = false, failed = false;
  if (tralbum?.id) {
    const type = tralbum.item_type === 'track' ? 't' : 'a';
    for (const ep of ['thumbs', 'reviews']) {
      let token = null;
      grp = ep === 'thumbs' ? 0 : 1;
      for (let i = 0; i < (first ? FIRST_PAGES : 40); i++) {
        if (!first && users.size >= max) { more = true; break; }
        const body = { tralbum_type: type, tralbum_id: tralbum.id, count: 100 };
        if (token) body.token = token;
        let res;
        // Käuferliste ist das Wichtigste: bei einem Fehler zweimal nachfassen (nach 3 und 8 s), statt mit wenigen Fans aufzuhören
        for (const wait of [0, 3000, 8000]) {
          if (wait) await sleep(wait);
          try { res = await postJson(`https://bandcamp.com/api/tralbumcollectors/2/${ep}`, body); break; } catch (e) { res = null; if (e.blocked) break; }
        }
        if (!res) { failed = true; break; }
        const rs = res.results || [];
        for (const r of rs) add(r.username || userFromHref(r.url || r.fan_url || ''), r.fan_id, r.name, r.image_id, r.token);
        flush();
        if (first && i === FIRST_PAGES - 1 && res.more_available) more = true;   // sehr großer Release: die frühesten, die erreichbar sind
        if (!res.more_available || !rs.length) break;
        token = rs[rs.length - 1].token;
        if (!token) break;
      }
    }
  }
  if (first) {
    // Bandcamp liefert die neuesten zuerst: umdrehen (mit Zeitstempel aus dem Token, wenn vorhanden)
    const list = [...users.values()].sort((a, b) => ((a.ts ?? Infinity) - (b.ts ?? Infinity)) || (a.g - b.g) || (b.n - a.n));
    onUsers(list);
    return { users: list, more: false, failed, first: true, ...meta };
  }
  return { users: [...users.values()], more, failed, ...meta };
}

// Fans, denen du auf Bandcamp folgst. 0.9.60: Ergebnis trägt total (Bandcamps Zahl, sonst gelesene) und why (warum weniger).
// Weiter wird geblättert, solange Bandcamp mehr meldet oder weniger da sind als die bekannte Gesamtzahl; nächster Token =
// last_token, sonst der Token des letzten Eintrags. Schneller Weg und Profilseite ergänzen sich (früher: Rückfall nur ohne Treffer).
async function followedFans() {
  const out = new Map();
  let total = null, why = '';
  const add = (f) => {
    const u = f.username || userFromHref(f.trackpipe_url || f.url || f.fan_url || '');
    if (u && !out.has(u)) out.set(u, { u, fanId: f.fan_id, name: f.name || u, img: f.image_id || null });
  };
  const known = (n) => { if (Number.isFinite(+n) && +n > 0) total = Math.max(total || 0, +n); };
  const short = () => total != null && out.size < total;
  const diag = [];   // 0.9.62: was Bandcamp pro Seite liefert – fürs Protokoll, falls doch welche fehlen
  const page = async (token) => {
    for (let i = 0; i < 100; i++) {
      const res = await postJson('https://bandcamp.com/api/fancollection/1/following_fans',
        { fan_id: S.me.fanId, older_than_token: token, count: 100 });
      // 0.9.64: Bandcamp nennt die Liste wirklich „followeers“ (laut Protokoll), sonst das erste Feld mit einer Liste
      const list = res.followeers || res.followeds || res.items || res.results || Object.values(res).find(Array.isArray) || [];
      if (diag.length < 6) diag.push(`${list.length}${res.more_available ? '+' : ''}${res.last_token ? 'T' : ''}${list[list.length - 1]?.token ? 't' : ''}`
        + (diag.length ? '' : ` [${Object.keys(res).join(',')}]`));
      known(res.item_count ?? res.total_count);
      const had = out.size;
      list.forEach(add);
      if (!res.more_available && !short()) { why = ''; return; }
      const next = res.last_token || list[list.length - 1]?.token || null;
      if (!list.length || out.size === had || !next || next === token) { why = ''; return; }   // keine weitere Seite
      token = next;
    }
  };
  // Schneller Weg: direkt die Liste abfragen (spart die große Profilseite)
  let fastOk = false;
  try { await page('9999999999:9999999999'); fastOk = true; } catch (e) { if (e.blocked) throw e; why = e.message; }
  if (!out.size || !fastOk || short()) {
    try {
      const { data } = await fanPage(S.me.username);
      const cache = Object.values(data.item_cache?.following_fans || {});
      cache.forEach(add);
      const info = data.following_fans_data;
      known(info?.item_count);
      // ältester Eintrag im Zwischenspeicher der Seite (Token beginnt mit der Zeit)
      const last = cache.map((f) => f.token).filter(Boolean).sort((a, b) => parseFloat(a) - parseFloat(b))[0];
      const tok = info?.last_token || last;
      if (tok && (total == null ? !!info?.last_token : out.size < total)) {
        try { await page(tok); } catch (e) { if (e.blocked && !out.size) throw e; why = e.message; }
      }
    } catch (e) { if (!out.size) throw e; why ||= e.message; }   // was da ist, reicht
  }
  const res = [...out.values()];
  res.total = Math.max(total || 0, res.length);
  log(`Gefolgte Fans: ${res.length} gelesen (Bandcamp nennt ${total ?? '?'}) · Seiten ${diag.join(' / ') || '–'}${fastOk ? '' : ' · über Profilseite'}`);
  if (res.length < res.total) {
    res.why = why || t('Bandcamp lieferte keine weitere Seite');
    log(t('Gefolgte Fans: nur {a} von {b} gelesen ({reason})', { a: res.length, b: res.total, reason: res.why }));
  }
  return res;
}

// Wem du folgst, wird höchstens alle 30 Minuten neu abgefragt (eine kleine Anfrage)
const FOLLOWED_MIN = 30;
// 0.9.61: Vergleich ohne Groß/Klein (Bandcamp schreibt Namen mal so, mal so), über ein Set statt includes
let folSet = null, folSrc = null, folF = null, unfSet = null;
function folSync() {
  if (folSet && folSrc === S.followed && folF === S.follow) return;   // 0.9.68: neu installiert (beides null) – Set trotzdem bauen
  folSrc = S.followed; folF = S.follow;
  // 0.9.65: auf der Profilseite entfolgt (pf[u] === false) – zählt sofort nicht mehr, auch wenn S.follow.fans ihn noch hat
  unfSet = new Set(Object.entries(S.followed?.pf || {}).filter(([, on]) => on === false).map(([x]) => x.toLowerCase()));
  folSet = new Set([...(S.followed?.users || []), ...Object.keys(S.follow?.fans || {})].map((x) => String(x).toLowerCase()).filter((x) => !unfSet.has(x)));
}
function isFollowed(u) {
  if (!u) return false;
  folSync();
  return folSet.has(String(u).toLowerCase());
}
// 0.9.65: Daten in S.follow.fans bleiben (wieder folgen bringt sie ohne Anfrage zurück), zählen aber nicht in Gefolgt/Promos
const unfollowed = (u) => (folSync(), !!u && unfSet.has(String(u).toLowerCase()));
function setFollowed(list) {
  // 0.9.62: auf Profilseiten gesehene Folgen (pf) gehen nicht verloren, falls Bandcamps Liste unvollständig ist
  const pf = S.followed?.pf || {}, users = list.map((f) => f.u), lc = new Set(users.map((x) => x.toLowerCase()));
  for (const [u, on] of Object.entries(pf)) if (on && !lc.has(u.toLowerCase())) users.push(u);
  S.followed = { at: Date.now(), users: users.filter((u) => pf[u] !== false), total: list.total ?? null, v: 64, pf };
  store.set({ followed: S.followed });
}
async function refreshFollowed() {
  if (!S.me || (S.followed && Date.now() - S.followed.at < FOLLOWED_MIN * 60e3)) return;
  const gen = dataGen;
  S.followed = { ...(S.followed || { users: [] }), at: Date.now() };   // keine Doppelabfrage, während diese läuft
  try { const list = await followedFans(); if (gen !== dataGen) return; setFollowed(list); renderMatches(); renderSoul(); } catch { /* nächstes Mal wieder */ }
}

// ---------- Bewertung ----------
function wilson(m, n, z = 1.64) {
  if (!n) return 0;
  const p = Math.min(1, m / n), z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

// Neue Wishlist-Einträge (Halbwertszeit ~3 Monate) und frühere Favoriten (★) zählen stärker
function computeMyWeights() {
  myW = new Map();
  const now = Date.now() / 1000;
  let sum = 0;
  for (const k of S.me?.keys || []) {
    const d = S.me.items?.[k]?.[6];
    const w = 1 + (d ? 2 * Math.exp(-(now - d) / DAY / 120) : 0) + (S.favs[k] ? 3 : 0);
    myW.set(k, w);
    sum += w;
  }
  meanW = myW.size ? sum / myW.size : 1;
}

// Scout-Score = Ähnlichkeit × Vorsprung × Aktivität
function score(f) {
  const n = f.total || 0, now = Date.now() / 1000, nc = f.nc ?? f.keys.length;
  let m = 0, mw = 0, dated = 0, ahead = 0, act = 0, hasDates = false;
  const leads = [];
  f.keys.forEach((k, i) => {
    const d = f.dt?.[i] || 0;
    if (d) hasDates = true;
    if (i < nc && d && now - d < 90 * DAY) act++;           // Käufe der letzten 90 Tage
    if (mySet.has(k)) {
      m++;
      mw += myW.get(k) || 1;
      const md = S.me?.items?.[k]?.[6];
      if (d && md) {
        dated++;
        const lead = (md - d) / DAY;                         // Tage, die der Fan früher dran war
        leads.push(lead);
        if (lead > 7) ahead++;
      }
    }
  });
  f.m = m;
  f.p = n ? m / n : 0;
  f.w = wilson(Math.min(n, meanW ? mw / meanW : m), n);
  f.lead = dated ? (ahead + 0.5) / (dated + 1) : null;      // geglättet, damit 1 von 1 nicht 100 % ist
  leads.sort((a, b) => a - b);
  f.leadMed = dated ? leads[Math.floor(leads.length / 2)] : null;
  f.act = hasDates ? act : null;
  const leadF = f.lead == null ? 0.75 : 0.5 + f.lead;
  const actF = f.act == null ? 0.6 : Math.min(1, 0.25 + f.act / 8);
  f.sc = f.w * leadF * actF;
}
function computeAll() { for (const f of Object.values(fans)) if (f.keys && !f.error) score(f); }

const inflight = new Map();
function scanFan(info, sourceKey, max = ITEMS, tally, probe = false, keep) {
  const run = inflight.get(info.u);
  if (run) return run.then(() => scanFanNow(info, sourceKey, max, tally, probe, keep));
  const p = scanFanNow(info, sourceKey, max, tally, probe, keep).finally(() => inflight.delete(info.u));
  inflight.set(info.u, p);
  return p;
}
// max: so viele neueste Käufe (Seelenverwandte holen 200; ein frisches kleines Profil wird dann vergrößert)
// probe: früh abbrechen erlaubt (nur die Suche nach Seelenverwandten); ein früh abgebrochenes Profil gilt ohne probe
// nicht als groß – „Tracks“ lädt es ganz
// keep (0.9.60): Höchstalter statt fanKeep – „Tracks“ frischt die besten 5/10/20 weiter nach 6 Stunden auf
async function scanFanNow(info, sourceKey, max = ITEMS, tally, probe = false, keep) {
  const u = info.u, ex = fans[u];
  const maxAge = !ex ? 0 : ex.error ? 3600e3 : keep ?? fanKeep(u, ex);   // Fehler: nach 1 h erneut versuchen
  if (ex && (Date.now() - ex.scannedAt) < maxAge && (ex.error || (ex.deep && (!ex.cut || probe)) || max <= ITEMS)) {
    let dirty = false;
    if (!ex.fanId && info.fanId) { ex.fanId = info.fanId; dirty = true; }
    if (info.img && ex.img !== info.img) { ex.img = info.img; dirty = true; }
    if (info.name && ex.name === u && info.name !== u) { ex.name = info.name; dirty = true; }
    if (sourceKey && !(ex.src ||= []).includes(sourceKey)) { ex.src.push(sourceKey); dirty = true; }
    if (dirty) await saveFan(u);
    return false;
  }
  let rec;
  const gen = dataGen;
  try {
    let fanId = info.fanId || ex?.fanId, name = info.name || ex?.name || u, data = null;
    if (!fanId) ({ fanId, name, data } = await fanPage(u, tally));   // nur wenn nötig
    const items = await newestItems(fanId, data, Math.max(ITEMS, max), tally, probe && max > PROBE_ITEMS);
    // 0.9.53: ein großes Profil, bei dem eine Seite fehlte, zählt nicht als geprüft (kommt später nochmal dran)
    rec = { u, name, fanId, deep: (max > ITEMS && !items.partial) || undefined, cut: (items.cut && !items.partial) || undefined, img: info.img || ex?.img || null, keys: items.map((x) => x[0]), dt: items.map((x) => x[1][6] || 0),
      nc: items.filter((x) => x[2] === 'c').length, total: items.length, scannedAt: Date.now(),
      src: [...new Set([...(ex?.src || []), ...(sourceKey ? [sourceKey] : [])])], meta: null };
    score(rec);
    // Seelenverwandte (großes Profil) teilen Releases auch außerhalb ihrer neuesten Käufe: ihre Lieder immer merken
    if (rec.m >= 1 || rec.deep) rec.meta = Object.fromEntries(items.filter((x) => !mySet.has(x[0])).map((x) => [x[0], x[1]]));
  } catch (e) {
    if (e.blocked) return 'blocked';   // nicht als Fehler merken – beim Weiterprüfen kommt der Fan wieder dran
    rec = { u, fanId: info.fanId || ex?.fanId, img: info.img || ex?.img || null, error: e.message, perm: isPerm(e) || undefined, keys: [], total: 0,
      m: 0, p: 0, w: 0, sc: 0, scannedAt: Date.now(), src: ex?.src || (sourceKey ? [sourceKey] : []) };
  }
  if (gen !== dataGen) return false;   // inzwischen „Alles löschen“ oder Import: nichts Altes zurückschreiben
  fans[u] = rec;
  await saveFan(u);
  return true;
}

async function pool(list, n, fn, alive) {
  let idx = 0;
  const worker = async () => { while (alive() && idx < list.length) await fn(list[idx++]); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, list.length)) }, worker));
}

// ---------- Offener Tab ----------
function normUrl(u) {
  try {
    const x = new URL(u.trim());
    if (!x.hostname.endsWith('bandcamp.com') || !/\/(album|track)\//.test(x.pathname)) return null;
    return x.origin + x.pathname;
  } catch { return null; }
}

async function syncTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  curTabId = tab.id;
  curTabBc = /^https:\/\/([^/]+\.)?bandcamp\.com\//.test(tab.url || '');
  const url = normUrl(tab.url || '');
  // Auf Bandcamp neu gemerkte Lieder schnell übernehmen (höchstens alle 2 Minuten, nicht während einer Suche)
  if (url && S.me && Date.now() - (S.me.checkedAt || 0) > 120e3 && !cur?.scanning && !scoutsRunning && !soulRunning) refreshMe();
  // Die Liste bleibt stehen; ein Release wird nur auf Knopfdruck („Suche starten“) ausgelesen
  if (url && url !== cur?.url) {
    pending = { url, title: (tab.title || '').replace(/\s*\|\s*/, ' · ') || url };
  } else {
    pending = null;
    pre = null;
  }
  renderPending();
  if (!S.me) guessMe();   // 0.9.68: neuer Nutzer – angemeldeten Namen erkennen
}

// Vorab-Prüfung: Während du einen anderen Release links anhörst, werden seine Fans schon im Hintergrund geprüft.
// Die Liste rechts bleibt dabei stehen; „Diesen Release auslesen“ ist dann sofort fertig.
let prefetchJob = 0, pre = null;   // pre: { url, done, total, ready }
async function prefetchRelease(url, tabId) {
  const job = ++prefetchJob, alive = () => job === prefetchJob && pending?.url === url;
  pre = { url, done: 0, total: 0, ready: false };
  renderPending();
  while (alive() && (cur?.scanning || soulRunning)) await sleep(300);   // laufende Suche geht vor
  // warten, bis die Seite links fertig geladen ist – dann lässt sie sich direkt auslesen
  for (let i = 0; i < 25 && alive(); i++) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'complete') break;
    await sleep(200);
  }
  if (!alive() || !S.me) return;
  let list;
  const cached = S.rel[url];
  if (relFresh(cached) && (cached.fans.length >= FAN_STEP || !cached.more)) list = cached.fans;
  else {
    try {
      const info = await supporters(url, { max: FAN_STEP, tabId, first: fanOrder() === 'first' });
      const me = S.me.username.toLowerCase();
      list = info.users.map((x) => x.u).filter((u) => u.toLowerCase() !== me).slice(0, FAN_STEP);
      for (const x of info.users) if (x.fanId && !fans[x.u]?.fanId) (pre.ids ??= {})[x.u] = x;
      S.rel[url] = { key: info.key, title: info.title, artist: info.artist, art: info.art, fans: info.first ? info.users.map((x) => x.u).filter((u) => u.toLowerCase() !== me) : list, more: info.more, ord: fanOrder(), at: info.failed ? 0 : Date.now() };
      pruneRel();
      await store.set({ rel: S.rel });
    } catch { if (alive()) { pre = null; renderPending(); } return; }
  }
  if (!alive()) return;
  const key = S.rel[url].key || url;
  pre.total = list.length;
  renderPending();
  await pool(list, S.settings.concurrency, async (u) => {
    await scanFan(pre.ids?.[u] || { u, fanId: fans[u]?.fanId, img: fans[u]?.img }, key);
    if (alive()) { pre.done++; renderPending(); }
  }, alive);
  if (alive()) { pre.ready = true; renderPending(); }
}

function readRelease(url, tabId = curTabId) {
  prefetchJob++;   // was vorab schon geprüft ist, liegt im Speicher; den Rest übernimmt das Auslesen
  pre = null;
  pending = null;
  renderPending();
  nowTrack = '';
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'getNow' }).then((m) => {
    if (m?.url === cur?.url) { nowTrack = m.title || ''; renderNow(); }
  }).catch(() => {});
  openRelease(url, FAN_STEP, tabId);
}

function renderPending() {
  renderAction();
  $('#pending').classList.toggle('hidden', !pending);
  if (pending) $('#pendingTitle').textContent = pending.title;
  const p = pending && pre?.url === pending.url ? pre : null;
  $('#pendingInfo').textContent = !p ? t('Links geöffnet')
    : p.ready ? t('Links geöffnet · Fans schon geprüft, Auslesen geht sofort')
    : p.total ? t('Links geöffnet · prüfe Fans vorab: {done} von {total}', { done: p.done, total: p.total }) : t('Links geöffnet · suche Fans vorab …');
  if (!cur) { clearNow(); renderMatches(); }   // Kopf und leere Liste sagen, was als Nächstes zu tun ist
}

async function openRelease(url, limit = FAN_STEP, tabId = curTabId) {
  minTok = Infinity;
  const job = ++releaseJob, alive = () => job === releaseJob;
  const cached = S.rel[url], prev = cur?.url === url ? cur : null;
  // „Nächste 50“: ab hier sind die Fans neu dazugekommen und werden markiert
  const newFrom = prev && limit > prev.limit ? prev.limit : limit === prev?.limit ? prev.newFrom ?? null : null;
  const c = cur = { url, key: cached?.key || null, title: cached?.title || '', artist: cached?.artist || '', art: cached?.art || null,
    fans: [], scanning: true, done: 0, total: 0, error: null, limit, more: false, newFrom };
  renderNow(); renderMatches();
  const me = S.me?.username?.toLowerCase();
  const queue = [], seen = new Set(), ids = { ...(cached?.ids || {}) };
  const push = (arr) => {
    for (const x of arr) {
      if (x.u.toLowerCase() === me || seen.has(x.u)) continue;
      if (x.fanId) ids[x.u] = x.fanId;   // gemerkt: spart beim Weiterprüfen die große Profilseite
      seen.add(x.u); queue.push(x); c.fans.push(x.u); c.total++;
    }
  };
  // Schon bekannte Fans sind sofort fertig; Fans mit bekannter ID brauchen keine große Profilseite – die kommen zuerst
  const known = (u) => scanCost(u, cached);
  let producing = false, prod = Promise.resolve();
  if (relFresh(cached) && (cached.fans.length >= limit || !cached.more)) {
    c.more = !!cached.more;
    // günstige zuerst – aber nur innerhalb der ersten `limit`, sonst passt „geprüft“ nicht mehr zu „Weiter prüfen“ und zur gemerkten Ansicht
    const mk = (u) => ({ u, fanId: fans[u]?.fanId || cached.ids?.[u], img: fans[u]?.img });
    push([...cached.fans.slice(0, limit).map(mk).sort((a, b) => known(a.u) - known(b.u)), ...cached.fans.slice(limit).map(mk)]);
  } else {
    producing = true;
    setStatus(t('Lese Unterstützer dieses Releases …'));
    prod = supporters(url, {
      onMeta: (m) => { if (alive()) { Object.assign(c, m); renderNow(); } },
      onUsers: (arr) => { if (alive()) push(arr); },
      max: limit,
      tabId,
      first: fanOrder() === 'first',
    }).then(async (info) => {
      if (!alive()) return;
      c.more = info.more;
      c.partial = info.failed;
      if (info.failed && Date.now() < blockedUntil) c.blocked = true;   // Käuferliste wegen Sperre unvollständig: „Weiter prüfen“
      S.rel[url] = { key: c.key, title: c.title, artist: c.artist, art: c.art, fans: c.fans, ids, more: info.more, ord: fanOrder(), at: info.failed ? 0 : Date.now() };   // unvollständig: beim nächsten Mal neu lesen
      pruneRel();
      await store.set({ rel: S.rel });
    }).catch((e) => { if (alive()) { if (e.blocked) c.blocked = true; if (!c.fans.length) c.error = e.message; } })
      .finally(() => { producing = false; });
  }
  if (!S.me) { await prod; if (alive()) { c.scanning = false; setStatus(''); renderMatches(); } return; }

  const t0 = Date.now();
  let fresh = 0, idx = 0, lastRender = 0;
  const step = () => {
    const wait = Math.ceil((pauseUntil - Date.now()) / 1000);
    setStatus(t('Prüfe Fans: {done} von {total}', { done: c.done, total: Math.min(c.total, c.limit) }) + (producing ? t(' (weitere werden noch gesucht)') : '')
      + (wait > 0 ? t(' · Bandcamp bremst, weiter in {s} s', { s: wait }) : tokens < 1 ? t(' · wartet kurz auf Bandcamps Limit') : ''));
    if (Date.now() - lastRender > 700) { lastRender = Date.now(); renderMatches(); if (tipsOn) renderTips(); }   // Treffer laufend anzeigen
  };
  const worker = async () => {
    while (alive()) {
      if (idx < queue.length && idx < c.limit) {
        if (Date.now() < blockedUntil) { c.blocked = true; break; }
        const x = queue[idx++];
        const r = await scanFan(x, c.key || url);
        if (!alive()) return;
        if (r === 'blocked') { c.blocked = true; break; }
        if (r) fresh++;
        c.done++;
        step();
      } else if (producing && idx < c.limit && !c.blocked) await sleep(100);
      else break;
    }
  };
  const tick = setInterval(() => { if (alive() && c.scanning) step(); }, 1000);   // Fortschritt und Bremsung auch während Wartezeiten zeigen
  try {
    await Promise.all(Array.from({ length: Math.max(1, S.settings.concurrency) }, worker));
    await prod;
  } catch (e) {
    log(t('Fehler bei der Suche: {err}', { err: e.message }));
  } finally {
    clearInterval(tick);
    if (alive()) c.scanning = false;   // nie in „Suche läuft …“ hängen bleiben
  }
  if (!alive()) return;
  refreshFollowed();   // erst nach der Suche: deren Anfragen waren im Startknopf eingeplant, diese nicht
  bucketOk(fresh);
  if (!c.blocked) learnFresh(fresh, c.done);
  if (fresh) log(t('{title}: {n} Fans neu geprüft in {s} s', { title: c.title, n: fresh, s: ((Date.now() - t0) / 1000).toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }));
  if (!c.blocked) autoGo = null;
  else if (autoGo?.url !== url || autoGo.limit !== c.limit) autoGo = { url, limit: c.limit, n: 0 };
  else if (autoGo.n >= AUTO_MAX) autoGo = null;
  setStatus(c.blocked ? t(autoGo ? 'Bandcamp hat gebremst – {done} von {total} Fans geprüft. Die Suche geht von selbst weiter, sobald Bandcamps Limit reicht.'
    : 'Bandcamp hat gebremst – {done} von {total} Fans geprüft. Oben auf „Weiter prüfen“, sobald der Knopf frei ist.', { done: c.done, total: Math.min(c.total, c.limit) })
    : c.partial ? t('Bandcamp hat die Käuferliste gerade blockiert, deshalb nur {n} Fans. Öffne den Release in ein paar Minuten nochmal.', { n: c.total }) : '');
  renderMatches(); renderTips();
  saveView();
}

// Ansicht merken, damit nach dem Ausblenden der Leiste (» oder Alt + T) alles wieder so dasteht – ohne neue Anfragen
function saveView() {
  store.set({ view: { url: cur?.url || null, limit: cur?.limit || FAN_STEP, tab: realTab, tabView: { ...tabView }, tipsOn } });
}
function restoreView(v) {
  if (!v) { showTab(startTab(), false); return; }
  tipsOn = !!v.tipsOn;
  // bis 0.9.47: tab 'tips' = Trackvorschläge, soulOn = Modus „Seelenverwandte“
  if (v.tabView) Object.assign(tabView, v.tabView);
  else if (v.tab === 'tips') tabView[v.soulOn ? 'soul' : 'match'] = 'tracks';
  const tab = v.tab === 'scouts' || v.tab === 'promos' ? v.tab : v.tab === 'soul' || v.soulOn ? 'soul' : v.tab ? 'match' : startTab();
  const rel = v.url && S.rel[v.url];
  if (rel?.fans?.length) {
    const limit = Math.max(FAN_STEP, Math.min(v.limit || FAN_STEP, rel.fans.length));
    const first = rel.fans.slice(0, limit);
    const done = first.filter((u) => fanFresh(u) || fans[u]?.error).length;   // kaputte Profile gelten als geprüft (neuer Versuch bei der nächsten Suche)
    cur = { url: v.url, key: rel.key, title: rel.title, artist: rel.artist, art: rel.art, fans: [...rel.fans], scanning: false,
      done, total: rel.fans.length, error: null, limit, more: !!rel.more, partial: !rel.at, blocked: done < first.length };
  }
  showTab(tab, false);
}

// Fan-Profile und Käuferlisten älter als 6 Stunden löschen (der gerade angezeigte Release bleibt, bis du einen anderen öffnest);
// 0.9.66: große Profile der besten 300 Seelenverwandten nie nach Alter (Fehler-Profile weiter nach 6 Stunden); „Cache leeren“ löscht sie
function pruneOld() {
  const now = Date.now(), old = now - KEEP_MS, keep = new Set(cur?.fans || []), gone = [];
  for (const [u, f] of Object.entries(fans)) {
    const age = !f.error && f.deep && twinKeep().has(u) ? TWIN_KEEP_MS : KEEP_MS;
    if (!(f.scannedAt > now - age) && !keep.has(u) && !inflight.has(u)) { delete fans[u]; gone.push('fan:' + u); }
  }
  let relDirty = false;
  for (const [url, r] of Object.entries(S.rel)) if (!(r.at > old) && url !== cur?.url) { delete S.rel[url]; relDirty = true; }
  if (gone.length) { store.remove(gone); popVer++; }
  if (relDirty) store.set({ rel: S.rel });
  const oldSeeds = [];
  for (const [k, sd] of Object.entries(S.soul.seeds)) if (!(sd.at > Date.now() - SEED_KEEP)) { delete S.soul.seeds[k]; oldSeeds.push('seed:' + k); }
  if (oldSeeds.length) { store.remove(oldSeeds); soulVer++; }
}
setInterval(() => { if (!cur?.scanning && !pre?.total && !soulRunning) pruneOld(); }, 15 * 60e3);
function pruneRel() {
  const urls = Object.keys(S.rel);
  if (urls.length <= 300) return;
  urls.sort((a, b) => S.rel[a].at - S.rel[b].at).slice(0, urls.length - 300).forEach((u) => delete S.rel[u]);
}

// ---------- Seelenverwandte: Fans, die mehrere deiner Releases gekauft haben ----------
// Ein Durchgang liest die Käuferlisten weiterer deiner Releases (die zuletzt dazugekommenen und ★ zuerst). Wer auf mehreren
// davon steht, hat sicher mehrere gemeinsame Releases. Von den besten Kandidaten wird danach ein großes Profil geladen
// (200 Käufe). Jeder weitere Durchgang nimmt die nächsten Releases dazu.
let soulJob = 0, soulProg = null;
// 0.9.52: Ergebnis und Rohdaten getrennt. Durchsuchte Releases (Käufernamen) gelten 30 Tage – die nächste Suche macht dort
// weiter statt von vorne. Die gefundenen Seelenverwandten (S.soul.twins: Name, Bild, gemeinsame Releases) bleiben dauerhaft.
// Volle Kauflisten (fans) gelten weiter nur 6 Stunden – 0.9.60: die der besten 300 Seelenverwandten dauerhaft (twinKeep, 0.9.66).
// 0.9.53: Wer auf mindestens 2 deiner Käuferlisten steht, kommt sofort in die Liste („noch nicht geprüft“, at = 0) – ohne
// erst sein großes Profil zu laden (0.9.54: etwa 10 Anfragen pro Person, siehe deepCost). Das kommt später, die mit den
// meisten Treffern zuerst (dann at = Zeitpunkt). Die Kauflisten der besten 5 werden nur noch aufgefrischt, wenn du „Tracks“ anschaust.
// 0.9.56: statt 5 einstellbar 5/10/20 (soulRefresh, Standard 20). 20 Profile (~200 Anfragen) sind mehr als ein voller Eimer:
// der Knopf öffnet bei 95 % (secondsFor), der Durchgang hält vor der Reserve an, den Rest holt der nächste (tracksAuto bleibt an).
// Gespeichert wird jede Käuferliste einzeln ('seed:'+Release), der Rest (twins, seen, run) unter 'soul'.
const SEED_KEEP = 30 * 864e5, SEED_RETRY = 3600e3;
const soulRefreshN = () => (REFRESH_STEPS.includes(S.settings.soulRefresh) ? S.settings.soulRefresh : DEFAULTS.soulRefresh);
const seedFresh = (k) => Date.now() - (S.soul.seeds[k]?.at || 0) < SEED_KEEP;
const soulMeta = () => { const { seeds, ...rest } = S.soul; return rest; };
const saveSoul = () => store.set({ soul: soulMeta() });
const saveSeeds = (ks) => (ks.length ? store.set(Object.fromEntries(ks.map((k) => ['seed:' + k, S.soul.seeds[k]]))) : null);
let soulVer = 0;   // steigt, wenn sich S.soul.seeds ändert (für den Zwischenspeicher von soulCands)
function soulSeedsNext() {
  return (S.me?.keys || []).filter((k) => /^[at]\d+$/.test(k) && !seedFresh(k))
    .sort((a, b) => ((myW.get(b) || 1) - (myW.get(a) || 1)) || ((S.me.items[b]?.[6] || 0) - (S.me.items[a]?.[6] || 0)))
    .slice(0, SOUL_SEEDS);
}
// Kandidaten: auf wie vielen deiner Releases jemand als Käufer steht. Kleine Releases zählen beim Gleichstand mehr,
// weil sie mehr über den Geschmack sagen als Hits, die jeder hat. Zwischengespeichert, bis sich Käuferlisten oder deine
// Liste ändern (der Knopf fragt jede Sekunde nach, und bei vielen durchsuchten Releases sind das viele Tausend Namen).
let candsMemo = null;
function soulCands() {
  const memo = candsMemo;
  if (memo && memo.seeds === S.soul.seeds && memo.ver === soulVer && memo.my === mySet) return memo.v;
  const me = S.me?.username?.toLowerCase(), m = new Map();
  for (const [k, sd] of Object.entries(S.soul.seeds)) {
    if (!seedFresh(k) || !mySet.has(k) || !sd.u.length) continue;
    const w = 1 / Math.log2(2 + (sd.more ? 1000 : sd.u.length));
    sd.u.forEach((u, i) => {
      if (u.toLowerCase() === me) return;
      const c = m.get(u) || { u, hits: [], w: 0, fanId: null, name: null, img: null };
      c.hits.push(k); c.w += w;
      c.fanId ||= sd.f?.[i] || null; c.name ||= sd.n?.[i] || null; c.img ||= sd.i?.[i] || null;
      m.set(u, c);
    });
  }
  const v = [...m.values()].sort((a, b) => (b.hits.length - a.hits.length) || (b.w - a.w));
  candsMemo = { seeds: S.soul.seeds, ver: soulVer, my: mySet, v, byW: null };
  return v;
}
// 0.9.57: Reihenfolge fürs Prüfen: Kandidaten mit ≥ 2 Treffern nach w (seltene Releases und viele Treffer heben es),
// bei Gleichstand mehr Treffer. Zwischengespeichert mit candsMemo (soulState fragt jede Sekunde).
function soulCandsByW(cands) {
  const memo = candsMemo?.v === cands ? candsMemo : null;
  if (memo?.byW) return memo.byW;
  const v = cands.filter((c) => c.hits.length >= 2).sort((a, b) => (b.w - a.w) || (b.hits.length - a.hits.length));
  if (memo) memo.byW = v;
  return v;
}
const deepFresh = (u) => fanFresh(u) && !!(fans[u].deep || fans[u].error);
// 0.9.60: wie deepFresh, aber mit der 6-Stunden-Regel (Auffrischen der besten 5/10/20 für „Tracks“)
const deepFresh6 = (u) => { const f = fans[u]; return !!f && (f.deep || f.error) && Date.now() - f.scannedAt < (f.error ? 3600e3 : KEEP_MS); };
// Profile, die eine Suche lädt: noch nicht geprüfte Kandidaten (≥ 2 Treffer), seltene zuerst (soulCandsByW) – danach
// Ungeprüfte aus der Liste, deren Treffer inzwischen aus den Käuferlisten herausgefallen sind
function soulDeepNext(cands = soulCands()) {
  const tw = S.soul.twins || {}, out = [], had = new Set();
  for (const c of soulCandsByW(cands)) {
    if (out.length >= SOUL_DEEP) break;
    if (!tw[c.u]?.at && !deepFresh(c.u)) { out.push(c); had.add(c.u); }
  }
  if (out.length < SOUL_DEEP) {
    const rest = Object.entries(tw).filter(([u, r]) => !r.at && !had.has(u) && !deepFresh(u))
      .sort((a, b) => ((b[1].w || 0) - (a[1].w || 0)) || ((b[1].keys?.length || 0) - (a[1].keys?.length || 0))).slice(0, SOUL_DEEP - out.length);
    for (const [u, r] of rest) out.push({ u, fanId: r.fanId, name: r.name, img: r.img, hits: r.keys || [] });
  }
  return out;
}
// Wann die nächste eben nicht erreichbare Käuferliste bzw. das nächste Profil wieder versucht wird (0 = keins)
function soulRetryAt() {
  let at = Infinity;
  for (const [k, sd] of Object.entries(S.soul.seeds)) if (sd.tmp && mySet.has(k)) at = Math.min(at, sd.at + SEED_KEEP);
  for (const [u, r] of Object.entries(S.soul.twins || {})) {
    const f = fans[u];
    if (!r.at && f?.error && !f.perm && fanFresh(u)) at = Math.min(at, f.scannedAt + 3600e3);
  }
  return at < Infinity && at > Date.now() ? at : 0;
}
// „Für Dich · Tracks“: die besten soulRefresh (5/10/20, soulTop beachtet minMatch), deren Kaufliste abgelaufen ist (6-Stunden-Regel,
// 0.9.60: auch wenn sie als einer der besten 300 weiter mitstimmt – 0.9.66: dauerhaft)
function soulRefreshNext() {
  return soulTop().slice(0, soulRefreshN()).filter((r) => !deepFresh6(r.u) || fans[r.u].cut)   // früh abgebrochen: ganz laden
    .map((r) => ({ u: r.u, fanId: r.fanId, name: r.name, img: r.img, hits: r.keys }));
}
const soulTracks = () => soulOn && tabView.soul === 'tracks';
// Daten aus einem frischen Profil in den dauerhaften Eintrag übernehmen; erst ein großes Profil zählt als „geprüft“
function twinFromProfile(r, f, keys) {
  for (const k of f.keys) if (mySet.has(k)) keys.add(k);
  r.name = (f.name && f.name !== f.u ? f.name : null) || r.name || f.u;
  r.img = f.img || r.img || null;
  r.fanId = f.fanId || r.fanId || null;
  r.lead = f.leadMed ?? r.lead ?? null;
  if (f.deep) {
    r.at = f.scannedAt; delete r.err;
    if (f.cut) r.cut = 1; else delete r.cut;   // 0.9.57: früh abgebrochen zählt als geprüft, bis ein volles Profil kommt
  }
}
// Dauerhafte Liste nachführen: jeder mit ≥ 2 Treffern auf deinen Käuferlisten kommt rein (auch ohne Profil); ein frisches
// Profil ergänzt die gemeinsamen Releases und den Vorsprung. Angezeigt wird ab minMatch gemeinsamen (soulTop).
function syncTwins() {
  computeAll();
  const tw = (S.soul.twins ||= {}), done = new Set();
  for (const c of soulCands()) {
    if (c.hits.length < 2) break;
    done.add(c.u);
    const r = (tw[c.u] ||= { name: c.name || c.u, img: c.img || null, fanId: c.fanId || null, keys: [], lead: null, w: 0, at: 0 });
    const keys = new Set([...(r.keys || []), ...c.hits]), f = fans[c.u];
    r.w = Math.max(r.w || 0, c.w);
    r.fanId ||= c.fanId || null; r.img ||= c.img || null;
    if (c.name && (!r.name || r.name === c.u)) r.name = c.name;
    if (f && fanFresh(c.u)) {
      if (!f.error) twinFromProfile(r, f, keys);
      // privat, gelöscht, kein Fan-Profil: nicht bei jeder Suche nochmal versuchen. Zeitüberschreitung, Serverfehler
      // oder kein Netz geben sich: dann bleibt er ungeprüft und kommt nach einer Stunde wieder dran.
      else if (!r.at && f.perm) { r.at = f.scannedAt; r.err = 1; }
    }
    r.keys = [...keys];
  }
  // Releases schon vor über 30 Tagen durchsucht (keine Käufernamen mehr): ein frisches großes Profil trotzdem übernehmen
  for (const [u, r] of Object.entries(tw)) {
    const f = fans[u];
    if (done.has(u) || !f || !fanFresh(u)) continue;
    if (f.error) { if (!r.at && f.perm) { r.at = f.scannedAt; r.err = 1; } continue; }
    if (!f.deep) continue;
    const keys = new Set(r.keys || []);
    twinFromProfile(r, f, keys);
    r.keys = [...keys];
  }
  twinVer++;
}
// Seelenverwandte, beste zuerst (gemeinsame Releases, die noch in deiner Liste sind)
// 0.9.57: früh abgebrochen (kauft gerade anderes) zählt beim Rang nur halb, angezeigt wird das echte n
const soulRank = (r) => (r.cut ? Math.ceil(r.n / 2) : r.n);
let twinVer = 0, keepMemo = null;   // 0.9.60: twinVer steigt mit jedem syncTwins (Zwischenspeicher der besten 300)
const keepKey = () => ({ tw: S.soul.twins, ver: twinVer, my: mySet, mm: S.settings.minMatch });
const sameKey = (a, b) => !!a && a.tw === b.tw && a.ver === b.ver && a.my === b.my && a.mm === b.mm;
// Benutzernamen der besten TWIN_KEEP_N Seelenverwandten (fanFresh fragt sehr oft: nur neu rechnen, wenn sich etwas geändert hat)
function twinKeep(top) {
  const k = keepKey();
  if (!top && sameKey(keepMemo?.k, k)) return keepMemo.v;
  const v = new Set((top || soulTop()).slice(0, TWIN_KEEP_N).map((r) => r.u));
  keepMemo = { k, v };
  return v;
}
function soulTop() {
  return Object.entries(S.soul.twins || {}).map(([u, r]) => ({ u, ...r, n: (r.keys || []).filter((k) => mySet.has(k)).length }))
    .filter((r) => r.n >= S.settings.minMatch)
    .sort((a, b) => (soulRank(b) - soulRank(a)) || ((b.lead ?? -1e9) - (a.lead ?? -1e9)) || ((b.w || 0) - (a.w || 0)));
}
// Anzeige: die dauerhafte Liste; f ist das frische Profil, wenn es eins gibt, sonst der gespeicherte Eintrag
// (unchk: bisher nur über die Käuferlisten bzw. ein kleines Profil gefunden, die 200 Käufe fehlen noch)
function soulList() {
  syncTwins();
  const top = soulTop();
  twinKeep(top);   // gleich mitmerken, spart fanFresh das Sortieren
  return top.map((r) => {
    const fresh = fanFresh(r.u) && !fans[r.u].error;
    const f = fresh ? (r.at ? fans[r.u] : { ...fans[r.u], unchk: true }) : { u: r.u, name: r.name, img: r.img, leadMed: r.lead, unchk: !r.at };
    return { f: r.cut && r.at ? { ...f, cut: true } : f, n: r.n };
  });
}
// Anfragen für einen ganzen Durchgang: neue Releases (je 2) und die Profile ihrer Kandidaten (je deepCost, ohne Fan-ID
// eine mehr) bzw. nur die Profile
function soulCost(mode = 'search') {
  const prof = (list) => list.reduce((n, r) => n + deepEst(r.fanId || fans[r.u]?.fanId), 0);
  if (mode === 'tracks') return Math.ceil(prof(soulRefreshNext()));
  const seeds = soulSeedsNext().length;
  return Math.ceil(prof(soulDeepNext()) + seeds * 2 + (seeds ? SOUL_DEEP * deepCost() : 0));
}
// Dauersuche: höchstens 80 % des gelernten Nachschubs – der Rest bleibt für dein eigenes Surfen und Hören auf Bandcamp
function autoPace(st, short) {
  const w = Math.ceil((soulAuto.next - Date.now()) / 1000);
  if (!soulAuto.on || w <= 0 || (st.wait || 0) >= w || (!st.run && !st.wait)) return st;
  return { label: t('{what} in {time}', { what: short, time: fmtCount(w) }), title: WAIT_TITLE(), wait: w };
}
function soulState() {
  if (!S.me) return { label: t('Seelenverwandte suchen'), title: t(NEED_ME) };
  // „Tracks“: erst die Kauflisten der besten 5/10/20 frisch laden. Kosten über dem Eimer deckelt secondsFor (95 %), kein Stillstand.
  if (soulTracks() && soulRefreshNext().length) {
    return gated(t('Tracks der Besten laden'), soulCost('tracks') + soulReserve(), () => soulRun('tracks'), t('Tracks laden'));   // du schaust gerade hin: nicht bremsen
  }
  const seeds = soulSeedsNext().length, deep = soulDeepNext().length;
  if (!seeds && !deep) {
    // nur noch Käuferlisten oder Profile, die eben nicht erreichbar waren: die kommen nach einer Stunde nochmal dran
    const w = Math.ceil((soulRetryAt() - Date.now()) / 1000);
    if (w > 0) return { label: t('{what} in {time}', { what: t('Weiter'), time: fmtCount(w) }), title: t('Ein paar Käuferlisten oder Profile waren gerade nicht erreichbar. Sie kommen nach einer Stunde nochmal dran.'), wait: w };
    return { label: '✓ ' + t('Alle deine Releases durchsucht'), title: t('Nach 30 Tagen werden deine Releases neu durchsucht.') };
  }
  // freigegeben erst, wenn der Durchgang samt Reserve durchläuft (dein eigenes Surfen zieht bei Bandcamp mit ab);
  // die Dauersuche startet schon mit kleineren Schritten, damit die Liste gleichmäßig wächst (0.9.54: mindestens ein Profil)
  const step = Math.max(AUTO_STEP, Math.ceil(deepCost()) + 2);
  const cost = (soulAuto.on ? Math.min(soulCost(), step) : soulCost()) + soulReserve(), run = () => soulRun();
  if (!Object.keys(S.soul.seeds).length) return autoPace(gated(t('Seelenverwandte suchen'), cost, run), t('Suche'));
  if (!seeds) return autoPace(gated(t('Weitere Kandidaten prüfen'), cost, run, t('Weiter')), t('Weiter'));
  // 0.9.53: kein „Weitere 15“ mehr – wie viele Releases ein Durchgang schafft, hängt von Bandcamps Limit ab
  const st = gated(t('Weiter suchen'), cost, run, t('Weiter'));
  return autoPace(st.run ? { ...st, title: t('Liest die Käuferlisten deiner nächsten Releases, so viele wie Bandcamps Limit gerade zulässt.') } : st, t('Weiter'));
}
// Käuferliste eines deiner Releases: die neuesten 100 Käufer plus die mit Rezension (2 Anfragen, ohne die Release-Seite)
async function soulSeed(k, tally) {
  const sd = { u: [], f: [], n: [], i: [], more: false };
  for (const ep of ['thumbs', 'reviews']) {
    const res = await postJson(`https://bandcamp.com/api/tralbumcollectors/2/${ep}`, { tralbum_type: k[0], tralbum_id: +k.slice(1), count: 100 }, tally);
    for (const r of res.results || []) {
      const u = r.username || userFromHref(r.url || r.fan_url || '');
      if (!u || sd.u.includes(u)) continue;
      sd.u.push(u); sd.f.push(r.fan_id || null); sd.n.push(r.name || null); sd.i.push(r.image_id || null);
    }
    if (res.more_available) sd.more = true;
  }
  return sd;
}
function soulStep() {
  if (!soulProg) return;
  const wait = Math.ceil((pauseUntil - Date.now()) / 1000);
  setStatus(t(['', 'Lese Käuferlisten deiner Releases: {done} von {total}', 'Lade die besten Kandidaten: {done} von {total}',
    'Lade die Kauflisten deiner besten Seelenverwandten: {done} von {total}'][soulProg.phase], soulProg)
    + (wait > 0 ? t(' · Bandcamp bremst, weiter in {s} s', { s: wait }) : tokens < 1 ? t(' · wartet kurz auf Bandcamps Limit') : ''));
}
// Dauer mit Einheit (eine nackte „12:05“ liest sich wie eine Uhrzeit)
const fmtDur = (sec) => (sec < 60 ? `${sec} s` : `${fmtCount(sec)} min`);
// 0.9.54: grobe Restdauer in Minuten: unter 90 min in Minuten, sonst in Stunden (unter 10 h mit einer Nachkommastelle)
function fmtEta(min) {
  if (min < 90) return t('etwa {x} min', { x: Math.max(1, Math.round(min)) });
  const h = min / 60;
  return t('etwa {x} h', { x: h < 10 ? h.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : Math.round(h) });
}
// Dauersuche: Zeit, in der sie laufen konnte (ohne die Zeit in anderen Reitern)
const autoActive = () => Math.max(0, Date.now() - soulAuto.t0 - soulAuto.away);
// 0.9.53: Dauersuche – startet den nächsten Durchgang von selbst, sobald Bandcamps Limit es zulässt. Nur solange „Für Dich“
// offen ist (sonst nähme sie einer Suche in den anderen Reitern die Anfragen weg). Hält bei jeder Sperre an, auch wenn
// sie nicht in ihrem eigenen Durchgang kam, und wenn Bandcamp nicht antwortet. Wird nicht gespeichert: nach dem Öffnen
// der Leiste ist sie aus, damit nie ungefragt Anfragen rausgehen.
function startAuto() {
  const now = Date.now();
  Object.assign(soulAuto, { on: true, t0: now, tick: now, away: 0, req: 0, neu: 0, deep: 0, cut: 0, passes: 0, next: 0, brk: brakeN, blk: blockedUntil });
  $('#soulAuto').checked = true;
  if (!soulRunning) setStatus(t('Dauersuche an: sie startet, sobald der Knopf oben frei ist.'));
  renderAction();
}
function stopAuto(why) {
  if (!soulAuto.on) return;
  soulAuto.on = false;
  $('#soulAuto').checked = false;
  if (why === 'reset') return;
  const sec = Math.round(autoActive() / 1000), min = Math.max(sec / 60, 0.5);
  if (soulAuto.passes) {
    const v = { time: fmtDur(sec), req: soulAuto.req, d: soulAuto.deep, x: soulAuto.cut, neu: soulAuto.neu, per5: Math.round((soulAuto.neu / min) * 5) };
    log(soulAuto.cut ? t('Dauersuche beendet nach {time}: {req} Anfragen, {d} Profile geprüft, {x} davon früh abgebrochen, {neu} neue Seelenverwandte (etwa {per5} pro 5 Minuten).', v)
      : t('Dauersuche beendet nach {time}: {req} Anfragen, {d} Profile geprüft, {neu} neue Seelenverwandte (etwa {per5} pro 5 Minuten).', v));
  }
  if (why === 'blocked') setStatus(t('Bandcamp hat gebremst, die Dauersuche ist aus. Gefundenes bleibt. Schalte sie wieder ein, sobald der Knopf oben frei ist.'));
  else if (why === 'error') setStatus(t('Bandcamp antwortet gerade nicht (kein Netz oder Serverfehler), die Dauersuche ist aus. Gefundenes bleibt.'));
  else if (why === 'done') setStatus(t('Alle deine Releases durchsucht, die Dauersuche ist fertig.'));
  else if (!soulRunning) setStatus('');
  renderAction();
}
setInterval(() => {
  if (soulAuto.on) {
    const now = Date.now();
    if (!soulOn) soulAuto.away += now - (soulAuto.tick || now);
    soulAuto.tick = now;
  }
  if (soulRunning) return;
  // eine Sperre außerhalb ihres Durchgangs (Wishlist-Abgleich, Tags, die Leiste im anderen Fenster) zählt genauso
  if (soulAuto.on && (brakeN !== soulAuto.brk || blockedUntil > soulAuto.blk)) { stopAuto('blocked'); return; }
  // eine nach einer Sperre wartende Release-Suche geht vor; ohne Netz wird nur gewartet
  const goWaits = autoGo && !pending && cur?.url === autoGo.url && cur.limit === autoGo.limit && cur.blocked;
  if (!soulOn || !S.me || cur?.scanning || scoutsRunning || goWaits || !navigator.onLine) return;
  const tracks = soulTracks() && tracksAuto && soulRefreshNext().length > 0;
  if (!soulAuto.on && !tracks) return;
  const st = soulState();
  if (st.run) { if (soulTracks()) tracksAuto = false; st.run(); }
  else if (soulAuto.on && !st.wait) stopAuto('done');
}, 1000);
// mode 'search': neue Releases und Kandidaten; 'tracks': nur die Kauflisten der besten 5 (für „Tracks“)
async function soulRun(mode = 'search') {
  if (!S.me || soulRunning) return;
  const tracks = mode === 'tracks';
  const job = ++soulJob, gen = dataGen, alive = () => job === soulJob && gen === dataGen;
  soulRunning = true; minTok = Infinity; renderAction();
  let used = 0, blocked = false, held = false, lastRender = 0, flight = 0, nSeeds = 0, nDeep = 0, fails = 0, deepReq = 0, nCut = 0, cutReq = 0;
  const meas = [];   // 0.9.54: echte Anfragen je großem Profil (ohne Profilseite) – daraus lernt deepCost (0.9.57: nur volle Profile)
  // fürs Protokoll: genau die Anfragen dieses Durchgangs nach Art, Dauer, wer neu dazukommt
  const t0 = Date.now(), tally = newTally(), before = new Set(soulList().map((x) => x.f.u));
  // gehört der Durchgang zu einer Dauersuche (auch wenn sie währenddessen aus- oder neu eingeschaltet wird)?
  const sess = soulAuto.on ? soulAuto.t0 : 0, cont = soulAuto.on && soulAuto.passes > 0;
  // Selbststopp: reicht es laut Rechnung nicht mehr für diesen Schritt plus Puffer, hört der Durchgang auf – der Rest
  // kommt beim nächsten dran. 0.9.47: Anfragen schon gestarteter Schritte zählen mit (flight), sonst greift er zu spät.
  // 0.9.57: bei laufenden Profilen (act) zählt nur der noch nicht verschickte Rest der Schätzung – was schon rausging,
  // fehlt bereits in tokens (sonst doppelt gezählt; ein früh abgebrochenes Profil gibt seinen Rest gleich frei)
  const act = new Set();
  const pend = () => { let n = flight; for (const a of act) n += Math.max(0, a.est - tallyReq(a.one)); return n; };
  const take = (cost) => {
    refill();
    if (held || tokens - pend() - cost < soulReserve()) { held = true; return false; }
    flight += cost; return true;
  };
  // Profil: reicht es nicht, aber laufen noch andere, erst auf deren Ende warten (ein früh abgebrochenes gibt seinen Rest
  // frei) und neu rechnen – angehalten wird erst, wenn nichts mehr läuft. Die Schätzung bleibt deepEst.
  let wake = null, wakeRes = null;
  const settled = () => (wake ||= new Promise((r) => { wakeRes = r; }));
  const done = (a) => { act.delete(a); if (wakeRes) { wakeRes(); wake = wakeRes = null; } };
  const takeDeep = async (a) => {
    for (;;) {
      refill();
      if (held || !alive() || blocked) return false;
      if (tokens - pend() - a.est >= soulReserve()) { act.add(a); return true; }
      if (!act.size) { held = true; return false; }
      await settled();
    }
  };
  // Liste höchstens alle 1,5 s neu zeichnen (bei vielen Seelenverwandten dauert das selbst ein bisschen)
  const live = () => { soulStep(); if (Date.now() - lastRender > 1500) { renderSoul(); if (activeTab() === 'tips') renderTips(); lastRender = Date.now(); } };
  const tick = setInterval(() => { if (alive()) soulStep(); }, 1000);
  const go = () => alive() && !blocked && !held;
  // große Profile laden (0.9.54: geschätzt mit deepCost, gezählt wird, was wirklich rausging – jedes Profil mit eigener Zählung)
  const deep = async (cands, phase) => {
    if (!cands.length || !go()) return;
    soulProg = { phase, done: 0, total: cands.length };
    live();
    await pool(cands, 4, async (c) => {
      if (Date.now() < blockedUntil) { blocked = true; return; }
      const fanId = c.fanId || fans[c.u]?.fanId, est = deepEst(fanId), one = newTally(), a = { est, one };
      if (!(await takeDeep(a))) return;
      try {
        // 0.9.57: nur die Suche bricht früh ab (phase 2), „Tracks“ lädt immer ganz
        const r = await scanFan({ u: c.u, fanId, name: c.name, img: c.img }, null, DEEP_ITEMS, one, phase === 2, phase === 3 ? KEEP_MS : undefined);
        if (r === 'blocked') { blocked = true; return; }
        const cost = tallyReq(one), f = fans[c.u];
        used += cost;
        if (r) {
          if (f?.error && !f.perm) fails++;
          else if (r === true && f?.cut) { nDeep++; nCut++; cutReq += cost; }
          else { nDeep++; deepReq += cost; }
          if (r === true && f && !f.error && f.deep && !f.cut) meas.push(cost - one.pages);   // Profilseite zählt nicht zum Schnitt „mit Fan-ID“
        }
        soulProg.done++; live();
      } finally { done(a); addTally(tally, one); }
    }, go);
  };
  try {
    if (tracks) await deep(soulRefreshNext(), 3);
    else {
      // 0.9.53: zwei Drittel des Budgets für neue Käuferlisten (2 Anfragen je Release) – jeder mit ≥ 2 Treffern steht damit
      // sofort in der Liste –, der Rest für die großen Profile der Kandidaten mit den meisten Treffern
      refill();
      const next = soulSeedsNext();
      const seeds = go() ? next.slice(0, Math.max(1, Math.floor((tokens - pend() - soulReserve()) / 3))) : [];
      const wrote = [];
      if (seeds.length) {
        soulProg = { phase: 1, done: 0, total: seeds.length };
        live();
        await pool(seeds, 4, async (k) => {
          if (Date.now() < blockedUntil) { blocked = true; return; }
          if (!take(2)) return;
          try {
            const sd = await soulSeed(k, tally);
            used += 2; nSeeds++;
            if (!alive()) return;
            S.soul.seeds[k] = { at: Date.now(), ...sd };
          } catch (e) {
            if (e.blocked) { blocked = true; return; }
            if (!alive()) return;
            // gelöscht oder privat: 30 Tage nicht nochmal versuchen; kein Netz, Serverfehler, Zeitüberschreitung: in einer Stunde
            if (isPerm(e)) S.soul.seeds[k] = { at: Date.now(), u: [], err: 1 };
            else { S.soul.seeds[k] = { at: Date.now() - SEED_KEEP + SEED_RETRY, u: [], err: 1, tmp: 1 }; fails++; }
          } finally { flight -= 2; }
          if (S.soul.seeds[k]) { wrote.push(k); soulVer++; }
          soulProg.done++; live();
        }, go);
        if (!alive()) return;
        await saveSeeds(wrote);   // schon gelesene Käuferlisten sichern, falls die Leiste währenddessen geschlossen wird
      }
      // 0.9.57: früh abgebrochene Profile lassen Budget übrig – dann die nächsten Kandidaten, bis der Selbststopp greift
      for (let i = 0; i < 20 && go(); i++) {
        const list = soulDeepNext(), was = nDeep + fails;
        if (!list.length) break;
        await deep(list, 2);
        if (nDeep + fails === was) break;   // nichts geschafft (z. B. nur Sperre/Fehler): nicht im Kreis laufen
      }
    }
  } catch (e) {
    log(t('Fehler bei der Suche: {err}', { err: e.message }));
  } finally {
    clearInterval(tick);
    if (job === soulJob) { soulRunning = false; soulProg = null; }
  }
  if (!alive()) return;
  bucketOk(used);
  // 0.9.54: Anfragen pro Profil nachlernen (ab 3 gemessenen Profilen, sanft: 60 % alt, 40 % dieser Durchgang)
  if (meas.length >= 3) {
    const avg = meas.reduce((a, b) => a + b, 0) / meas.length;
    S.deepCost = { v: Math.max(DEEP_MIN, Math.min(DEEP_MAX, round1(0.6 * deepCost() + 0.4 * avg))), at: Date.now() };
    store.set({ deepCost: S.deepCost });
  }
  // 0.9.57: Anteil früh abgebrochener Profile (ab 3 geprüften, 60/40 wie oben; der erste Wert gilt direkt)
  if (!tracks && nDeep >= 3) {
    const share = nCut / nDeep;
    S.cutShare = { v: Math.round(100 * (S.cutShare ? 0.6 * cutShare() + 0.4 * share : share)) / 100, at: Date.now() };
    store.set({ cutShare: S.cutShare });
  }
  const found = soulList(), n = found.length;
  // „neu“ = seit dem letzten Durchgang dazugekommen; bei der Dauersuche: seit sie eingeschaltet wurde
  if (!tracks && !cont) { S.soul.run = (S.soul.run || 0) + 1; S.soul.runAuto = !!sess; }
  S.soul.seen ||= {};
  for (const x of found) S.soul.seen[x.f.u] ??= S.soul.run;
  saveSoul();
  const req = tallyReq(tally), neu = found.filter((x) => !before.has(x.f.u)).length;
  const time = fmtDur(Math.round((Date.now() - t0) / 1000));
  const extra = (tally.pages ? t(', Profilseiten {n}', { n: tally.pages }) : '') + (tally.other ? t(', sonstige {n}', { n: tally.other }) : '');
  const err = fails ? t(' {n} nicht erreichbar, sie kommen später nochmal dran.', { n: fails }) : '';
  // 0.9.54: zum Nachprüfen – Käufe pro Abruf, Anfragen je Profil und was noch ungeprüft ist (mit grober Dauer)
  const per = tally.items ? t(' · {k} Käufe pro Abruf', { k: Math.round(tally.got / tally.items) }) : '';
  const nFull = nDeep - nCut;
  const each = (nFull ? t(' (je etwa {c} Anfragen)', { c: Math.round(deepReq / nFull) }) : '')
    + (nCut ? t(' ({x} früh abgebrochen, je etwa {c} Anfragen)', { x: nCut, c: Math.round(cutReq / nCut) }) : '');
  const open = tracks ? 0 : soulTop().filter((r) => !r.at).length;
  // 0.9.57: Restdauer mit gemischten Kosten (volle Profile und früh abgebrochene)
  const rest = open ? t(' · noch {u} ungeprüft ({eta})', { u: open, eta: fmtEta((open * blendCost()) / (0.8 * bucket().rate)) }) : '';
  log((tracks ? t('Tracks: {req} Anfragen in {time} (Kauflisten {i}{extra}){per} · {d} Profile frisch geladen{each}.', { req, time, i: tally.items, extra, per, d: nDeep, each })
    : t('Durchgang: {req} Anfragen in {time} (Käuferlisten {b}, Kauflisten {i}{extra}){per} · {r} Releases gelesen, {d} Profile geprüft{each} · {neu} neue Seelenverwandte, jetzt {n}{rest}.',
      { req, time, b: tally.buyers, i: tally.items, extra, per, r: nSeeds, d: nDeep, each, neu, n, rest })) + err);
  const mine = sess && soulAuto.on && soulAuto.t0 === sess;
  if (mine) {
    soulAuto.req += req; soulAuto.neu += neu; soulAuto.deep += nDeep; soulAuto.cut += nCut;
    if (!tracks) soulAuto.passes++;
    soulAuto.next = t0 + (req / (0.8 * bucket().rate)) * 60000;
  }
  if (blocked && soulAuto.on) stopAuto('blocked');
  else if (mine && fails && fails >= nSeeds + nDeep) stopAuto('error');
  else if (blocked) setStatus(t('Bandcamp hat gebremst. Oben auf den Knopf, sobald er frei ist – Gefundenes bleibt.'));
  else if (soulAuto.on) {
    setStatus(t('{n} Seelenverwandte, {neu} neue, {d} geprüft in {time} Dauersuche. Sie macht weiter, sobald Bandcamp wieder Luft hat.',
      { n, neu: soulAuto.neu, d: soulAuto.deep, time: fmtDur(Math.round(autoActive() / 1000)) }));
  } else if (tracks) setStatus(t('Tracks deiner besten Seelenverwandten geladen.'));
  else {
    setStatus(held ? t('{n} Seelenverwandte gefunden. Kurz vor Bandcamps Limit angehalten, der Rest kommt beim nächsten Durchgang.', { n })
      : t('{n} Seelenverwandte gefunden.', { n }));
  }
  // 0.9.56: „Tracks“ kurz vor der Reserve angehalten – der Rest kommt von selbst, sobald der Eimer wieder reicht
  // (nur wenn dieser Durchgang etwas geschafft hat – sonst liefe bei sehr kleinem Eimer eine leere Schleife)
  if (tracks && held && !blocked && used > 0 && soulTracks() && soulRefreshNext().length) tracksAuto = true;
  renderSoul(); renderTips(); renderAction();
}

chrome.tabs.onActivated.addListener(syncTab);
chrome.tabs.onUpdated.addListener((id, ch, tab) => {
  // Du öffnest selbst eine Bandcamp-Seite: kurz Pause machen, damit dein Seitenaufruf Vorrang hat und nicht gesperrt wird
  if (ch.status === 'loading' && /^https:\/\/([^/]+\.)?bandcamp\.com\//.test(tab.url || '')) yieldToUser();
  if (ch.status === 'complete') userDone();
  if (tab.active && (ch.url || ch.status === 'complete')) syncTab();
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'barDiag' && msg.how) log('Leiste: ' + String(msg.how).slice(0, 300));   // 0.9.70: Player-Leiste meldet, was sie nicht fand
  if (msg?.type === 'nowPlaying' && sender.tab?.id === curTabId && msg.url === cur?.url) { nowTrack = msg.title; renderNow(); }
  // 0.9.62: auf einer Fan-Profilseite zeigt Bandcamp „Following“ – das merken, auch wenn die Liste von Bandcamp unvollständig war
  if (msg?.type === 'fanFollowDiag' && msg.u && msg.how) log(`Profil ${msg.u}: ${msg.how}`);
  if (msg?.type === 'fanFollow' && msg.u && S.me && msg.u.toLowerCase() !== S.me.username?.toLowerCase()) {
    const users = S.followed?.users || [], lc = msg.u.toLowerCase(), has = users.some((x) => x.toLowerCase() === lc), was = isFollowed(msg.u);
    const pf = Object.fromEntries(Object.entries(S.followed?.pf || {}).filter(([x]) => x.toLowerCase() !== lc));   // eine Schreibweise je Fan
    pf[msg.u] = !!msg.on;
    S.followed = { ...(S.followed || { at: Date.now(), v: 64 }), pf, users: msg.on ? (has ? users : [...users, msg.u]) : users.filter((x) => x.toLowerCase() !== lc) };
    store.set({ followed: S.followed });
    if (was === isFollowed(msg.u)) return;
    renderMatches(); renderSoul();
    renderScouts(); renderPromos();   // 0.9.65: seine Käufe zählen sofort nicht mehr (bzw. wieder); Zeilen verschwinden an ihrem Platz
  }
});

// ---------- Eigene Wishlist ----------
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const sig = (artist, title) => norm(artist) + '|' + norm(title);
function buildMine() {
  mySet = new Set(S.me?.keys || []);
  mySigs = new Set();
  for (const m of Object.values(S.me?.items || {})) {
    if (m[0]) mySigs.add(sig(m[1], m[0]));
    if (m[4]) mySigs.add(sig(m[1], m[4]));
  }
}
// Hast du diesen Release schon – egal ob als Album, als Track daraus oder unter anderer ID?
function isMine(k, meta, t) {
  if (mySet.has(k) || mySet.has(t.tk)) return true;
  if (meta[8] && mySet.has('a' + meta[8])) return true;            // Track aus einem Album, das du hast
  return mySigs.has(sig(meta[1], meta[0])) || (t.title && mySigs.has(sig(meta[1], t.title)));
}

// Holt nur die neuesten Einträge deiner Wishlist (und Käufe) nach – eine Anfrage, damit Neues sofort zählt
let refreshingMe = null;
function refreshMe() {
  if (!S.me?.fanId || loadingMe) return Promise.resolve();
  const gen = dataGen, me = S.me;   // nach „Alles löschen“/Import nichts vom alten Stand zurückschreiben
  return (refreshingMe ??= (async () => {
    try {
      const kinds = S.settings.includeWishlist ? ['collection', 'wishlist'] : ['collection'];
      let added = 0;
      for (const kind of kinds) {
        const res = await postJson(`https://bandcamp.com/api/fancollection/1/${kind}_items`,
          { fan_id: me.fanId, older_than_token: '9999999999::a::', count: 100 });
        if (gen !== dataGen || S.me !== me) return;
        for (const it of res.items || []) {
          const k = keyOf(it);
          if (k && !me.items[k]) { me.items[k] = metaOf(it); me.keys.push(k); added++; }
        }
      }
      me.checkedAt = Date.now();
      await store.set({ me });
      if (added) {
        buildMine(); computeMyWeights(); tasteTagsLoad();
        log(t('{n} neue Einträge deiner Wishlist/Käufe übernommen.', { n: added }));
        renderTips(); renderScouts(); renderPromos(); renderMatches();
      }
    } catch (e) { log(t('Wishlist-Abgleich fehlgeschlagen: {err}', { err: e.message })); } finally { refreshingMe = null; }
  })());
}

async function loadMe(raw) {
  const username = String(raw || '').trim().replace(/^https?:\/\/(www\.)?bandcamp\.com\//, '').replace(/[\/?#].*$/, '');
  if (!username) { toast(t('Bitte Benutzernamen eingeben.')); return; }
  if (loadingMe) return;
  loadingMe = true;
  setupErr = ''; renderSetup();
  const gen = dataGen;
  try {
    // Grundlage sind deine Käufe, die Wishlist kommt per Haken dazu (Standard: an)
    setStatus(t('Lade deine Käufe …'));
    const { fanId, data } = await fanPage(username);
    const all = new Map(await fanItems(fanId, data, 'collection', 100000));
    let wl = new Map();
    if (S.settings.includeWishlist) {
      setStatus(t('Lade deine Wishlist …'));
      wl = await fanItems(fanId, data, 'wishlist', 100000);
      for (const [k, v] of wl) if (!all.has(k)) all.set(k, v);
    }
    if (gen !== dataGen) throw new Error('abgebrochen');   // inzwischen „Alles löschen“ oder Import
    S.me = { username, fanId, keys: [...all.keys()], items: Object.fromEntries(all), wl: wl.size, loadedAt: Date.now() };
    buildMine();
    computeMyWeights();
    computeAll();
    await store.set({ me: S.me });
    await saveAllFans();
    setStatus(t('{all} Releases geladen ({wl} aus der Wishlist).', { all: all.size, wl: wl.size }));
    log(t('Eigene Liste geladen: {n} Einträge', { n: all.size }));
  } catch (e) {
    // 0.9.68: falscher Name bzw. kein Fan-Profil verständlich sagen (vorher „Fehler beim Laden: HTTP 404“)
    const msg = isPerm(e) ? t('Unter bandcamp.com/{user} gibt es kein Fan-Profil. Prüfe den Benutzernamen – er steht in der Adresse deiner Sammlung.', { user: username })
      : e.blocked ? t('Bandcamp bremst gerade. Versuch es in ein paar Minuten nochmal.') : t('Fehler beim Laden: {err}', { err: e.message });
    if (gen === dataGen) { setStatus(msg); setupErr = msg; log(t('Eigene Liste nicht geladen ({user}): {err}', { user: username, err: e.message })); }
  }
  loadingMe = false;
  if (S.me && gen === dataGen && !(await store.get('view')).view?.tab) showTab(startTab(), false);   // 0.9.58: noch kein Reiter gemerkt
  renderSetup(); renderMe(); renderTips(); tasteTagsLoad();
  if (S.me && cur) openRelease(cur.url);
}

// ---------- Neu bei Scouts: nur gefolgte Fans ----------
// Bei einer Aktualisierung werden pro Fan nur die neuesten Käufe nachgeladen (eine kleine Anfrage),
// solange die älteren schon bekannt sind. Nur neue Fans oder ein höher gestellter Regler brauchen den vollen Abruf.
async function followItems(f, prev, max) {
  let fanId = f.fanId || prev?.fanId || fans[f.u]?.fanId, data = null;
  if (!fanId) ({ fanId, data } = await fanPage(f.u));
  if (prev?.items && (prev.depth || prev.items.length) >= max) {
    const fresh = await newestItems(fanId, null, NEW_PEEK);
    const known = new Set(prev.items.map((x) => x[0]));
    const added = fresh.filter((x) => !known.has(x[0]));
    if (added.length < fresh.length || fresh.length < NEW_PEEK) {   // Anschluss an die bekannten Käufe gefunden
      return { fanId, depth: prev.depth || max, items: [...added, ...prev.items].slice(0, Math.max(max, prev.depth || 0)) };
    }
  }
  return { fanId, depth: max, items: await newestItems(fanId, data, max) };
}

async function refreshScouts() {
  if (!S.me) { toast(t('Bitte zuerst deine Wishlist laden.')); return; }
  const job = ++followJob, alive = () => job === followJob;
  scoutsRunning = true; renderAction(); minTok = Infinity;
  try { await scoutsRun(job, alive); } finally { if (job === followJob) { scoutsRunning = false; renderAction(); } }
}
async function scoutsRun(job, alive) {
  $('#scoutInfo').textContent = t('Lese die Fans, denen du folgst …');
  await refreshMe();
  let list;
  try { list = await followedFans(); if (!alive()) return; setFollowed(list); } catch (e) {
    $('#scoutInfo').textContent = t('Die Liste deiner gefolgten Fans ließ sich nicht lesen: {err}', { err: e.message });
    scoutsRunning = false; renderAction();
    return;
  }
  const max = S.settings.scoutItems;
  const prev = S.follow?.fans || {};
  const next = {};
  let i = 0, fail = 0, lastRender = 0, blocked = false;
  const t0 = Date.now();
  const going = () => alive() && !blocked;
  await pool(list, S.settings.concurrency, async (f) => {
    try {
      next[f.u] = { name: f.name, img: f.img, ...(await followItems(f, prev[f.u], max)) };
    } catch (e) {
      if (e.blocked) blocked = true;
      fail++;
      if (prev[f.u]) next[f.u] = prev[f.u];               // alte Daten behalten statt Lücke
    }
    if (!alive()) return;
    i++;
    // Ergebnisse laufend zeigen: schon gelesene Fans neu, die übrigen mit ihrem alten Stand
    if (Date.now() - lastRender > 800 || i === list.length) {
      lastRender = Date.now();
      renderScouts({ ...S.follow, fans: { ...prev, ...next } }, t('Lese gefolgte Fans: {i} von {n}', { i, n: list.length }));
    }
  }, going);
  if (!alive()) return;
  if (blocked) {   // Sperre: Gelesenes behalten, Rest mit altem Stand – später einfach nochmal starten
    S.follow = { at: S.follow?.at || Date.now(), count: list.length, total: list.total, fans: { ...prev, ...next } };
    await store.set({ follow: S.follow });
    scoutsRunning = false; renderAction();
    renderScouts(S.follow, t('Bandcamp hat gebremst – {i} von {n} Fans gelesen. Später oben nochmal starten.', { i, n: list.length }));
    renderPromos();
    return;
  }
  S.follow = { at: Date.now(), count: list.length, total: list.total, fans: next };   // 0.9.60: total = Bandcamps Zahl
  await store.set({ follow: S.follow });
  bucketOk(list.length);
  log(t('Tracksuche nach Fans: {n} gefolgte Fans in {s} s gelesen', { n: list.length, s: Math.round((Date.now() - t0) / 1000) }) + (fail ? t(', {fail} nicht erreichbar.', { fail }) : '.'));
  scoutsRunning = false; renderAction();
  renderScouts(); renderPromos();
}

// ---------- Tracks & Bilder ----------
// Einzeltrack -> der Track selbst; Album -> Lieblingstrack des Fans bzw. Featured-Track
function trackOf(k, meta) {
  const [title, artist, url, ftId, ftTitle, ftCustom, date, art] = meta;
  if (k[0] === 't') return { tk: k, trackId: k.slice(1), albumId: null, title, album: '', artist, url, custom: false, date, art };
  const albumId = k.slice(1);
  if (ftId) return { tk: 't' + ftId, trackId: String(ftId), albumId, title: ftTitle || t('(Track)'), album: title, artist, url, custom: !!ftCustom, date, art };
  return { tk: k, trackId: null, albumId, title: '', album: title, artist, url, custom: false, date, art };
}

const pad = (id) => String(id).padStart(10, '0');
const imgId = (x) => (/^\d+$/.test(String(x ?? '')) ? String(x) : null);   // nur Ziffern: landet in einem style-Attribut
const coverUrl = (art) => imgId(art) ? `https://f4.bcbits.com/img/a${pad(imgId(art))}_7.jpg` : null;
const avatarUrl = (img) => imgId(img) ? `https://f4.bcbits.com/img/${pad(imgId(img))}_42.jpg` : null;
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (s) => String(s).split(/[\s_.-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function pic(cls, url, label) {
  const style = url ? `background-image:url('${esc(url)}')` : `background:hsl(${hue(label)} 45% 45%)`;
  return `<span class="${cls}" style="${style}">${url ? '' : esc(initials(label))}</span>`;
}

function playerSrc(e) {
  const base = 'https://bandcamp.com/EmbeddedPlayer/';
  const style = 'size=large/bgcol=333333/linkcol=1da0c3/artwork=small/tracklist=false/transparent=true/';
  if (e.albumId && e.trackId) return `${base}album=${e.albumId}/${style}track=${e.trackId}/`;
  if (e.trackId) return `${base}track=${e.trackId}/${style}`;
  return `${base}album=${e.albumId}/${style}`;
}

// ---------- Player unten in der Leiste (Vorspulen per Klick/Ziehen, ←/→ = 10 s) ----------
const audio = new Audio();
audio.preload = 'auto';
let playing = null;
let hiddenCache = [], hiddenPick = new Set(), historyCache = [];   // Fenster „Ausgeblendete Lieder“ und „Wiedergabeverlauf“ (siehe unten)
// Kurzform eines Liedes zum Speichern (Ausgeblendete, Verlauf): genug, um es später zu zeigen, anzuhören und zu liken
const packSong = (e) => ({ t: e.title || '', al: e.album || '', ar: e.artist || '', u: e.url || null, art: e.art ?? null, id: e.trackId || null, alb: e.albumId || null, at: Date.now() });
const unpackSong = (tk, v) => ({ tk, title: v.t || '', album: v.al || '', artist: v.ar || '', url: v.u || null, art: v.art ?? null, trackId: v.id || null, albumId: v.alb || null, at: v.at || 0 });
const HISTORY_MAX = 100;
function addHistory(e) {
  if (!e?.tk || !e.url) return;
  S.history = [{ tk: e.tk, ...packSong(e) }, ...S.history.filter((x) => x.tk !== e.tk)].slice(0, HISTORY_MAX);
  store.set({ history: S.history });
}
// 0.9.59: „gehört“ – jedes Abspielen hier zählt, auch kurz. Gemerkt wird nur tk → Zeit (180 Tage, die neuesten 5000).
const HEARD_MAX = 5000, HEARD_DAYS = 180;
function trimHeard(h) {
  const from = Date.now() - HEARD_DAYS * 864e5;
  let ent = Object.entries(h).filter(([tk, at]) => tk && Number.isFinite(at) && at >= from);
  if (ent.length > HEARD_MAX) ent = ent.sort((a, b) => b[1] - a[1]).slice(0, HEARD_MAX);
  return Object.fromEntries(ent);
}
const isHeard = (tk) => !!S.heard[tk];
const heardBadge = () => `<b class="heardb" title="${esc(t('Schon hier angehört'))}">${esc(t('gehört'))}</b>`;
// Zeile gleich markieren, ohne die Liste neu zu zeichnen (sie sortiert also auch nicht um)
function heardRow(li) {
  if (!li || li.classList.contains('heard')) return;
  li.classList.add('heard');
  li.querySelector('.cnt')?.insertAdjacentHTML('afterend', heardBadge());
}
function markHeard(tk) {
  if (!tk) return;
  const neu = !S.heard[tk];
  S.heard[tk] = Date.now();
  if (neu && Object.keys(S.heard).length > HEARD_MAX) S.heard = trimHeard(S.heard);
  store.set({ heard: S.heard });
  updateBulk();
  for (const l of TAG_LISTS) heardRow(rowOf(l, tk));   // 0.9.60: das Lied im Player bleibt auch beim Neusortieren stehen
}
// 0.9.60: ein anderes Lied kommt in den Player bzw. der Player geht zu – das vorige Gehörte fällt beim nächsten Neusortieren weg
function heardFree(tk) {
  if (!S.settings.hideHeard || !tk || !isHeard(tk)) return;
  for (const l of TAG_LISTS) if (rowOf(l, tk)) showResort(l, true);
}
function unmarkHeard(tk) { delete S.heard[tk]; store.set({ heard: S.heard }); }

// 0.9.56: Überspringen erkennen. Gezählt wird nur, was wirklich lief: Schritte von timeupdate bei laufender Wiedergabe
// (Spulen per Klick oder ←/→ zählt nicht, Pause auch nicht). Wird das Lied nach weniger als 30 s durch ein anderes ersetzt
// oder die Leiste geschlossen, ohne dass es ein ♥ bekam, ist das ein Überspringen. Zu Ende gehört ist nie eins.
const SKIP_SEC = 30;
let heard = null;   // { e, sec, pos, started, done, na }
function heardTick() {
  const h = heard;
  if (!h || h.e !== playing || h.na) return;
  const p = audio.currentTime, d = p - h.pos;
  h.pos = p;
  if (!audio.paused && !audio.seeking && d > 0 && d < 2) h.sec += d;   // größere Sprünge sind Spulen
}
audio.addEventListener('timeupdate', heardTick);
audio.addEventListener('playing', () => { if (heard?.e === playing) { heard.started = true; heard.pos = audio.currentTime; } });
['seeking', 'seeked'].forEach((ev) => audio.addEventListener(ev, () => { if (heard?.e === playing) heard.pos = audio.currentTime; }));
// vor dem Weiterspielen (siehe unten 'ended') registriert: zu Ende gehört
audio.addEventListener('ended', () => { if (heard?.e === playing) heard.done = true; });
// Lied wird ersetzt bzw. die Leiste geht zu: gehörte Sekunden in den Verlauf, ggf. Überspringen merken
function endHeard() {
  const h = heard;
  heard = null;
  if (!h || h.na || !h.started) return;   // Bandcamp-Player als Rückfall oder nie angelaufen: nichts bekannt
  const x = S.history.find((y) => y.tk === h.e.tk);
  if (x) { x.h = Math.round(h.sec); store.set({ history: S.history }); }
  if (h.done || h.sec >= SKIP_SEC || S.liked[h.e.tk] || liking.has(h.e.tk) || h.e.list === 'hidden') return;
  addTaste(h.e, 'skip');
}
window.addEventListener('pagehide', () => endHeard());
const fmtTime = (t) => isFinite(t) ? `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '--:--';

// Abspielen wartet nicht hinter den Scan-Anfragen, sondern lädt direkt. Ergebnisse werden gemerkt.
const streams = new Map();
async function quickHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    if (res.status === 429) { if (Date.now() >= blockedUntil) brake(429, +res.headers.get('Retry-After') || 0); throw blockedError(); }   // echte Sperre: auch die Suche weiß dann Bescheid (in einer schon bekannten nichts neu lernen)
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  } finally { clearTimeout(timer); }
}
function streamFor(e) {
  if (!e.url) return Promise.reject(new Error('kein Link'));
  const id = e.url + '|' + (e.trackId || '');
  if (!streams.has(id)) {
    const p = loadStream(e);
    p.catch(() => streams.delete(id));      // Fehler nicht merken, nächster Klick versucht es neu
    streams.set(id, p);
  }
  return streams.get(id);
}
async function loadStream(e) {
  const doc = await quickHtml(e.url);
  saveTags(e.url, tagsFromDoc(doc), false, relInfo(doc));
  if (e.tk?.[0] === 't') trackLinkFrom(doc, e);
  const t = JSON.parse(doc.querySelector('script[data-tralbum]')?.getAttribute('data-tralbum') || '{}');
  const list = t.trackinfo || [];
  const tr = list.find((x) => e.trackId && String(x.track_id ?? x.id) === String(e.trackId) && x.file)
    || list.find((x) => x.file?.['mp3-128']);
  const src = tr?.file?.['mp3-128'];
  if (!src) throw new Error('kein Vorhör-Stream');
  return { src, title: tr.title || e.title, dur: tr.duration || 0 };
}

// next: tk des Liedes, das play() gleich lädt (dasselbe nochmal: nichts wird frei)
function closePlayer(next = null) {
  heard = null;   // Player zu (✕, „Alles löschen“) ist kein Überspringen; play() wertet vorher selbst aus
  const was = playing?.tk;
  audio.pause();
  audio.removeAttribute('src');
  playing = null;
  markPlaying(); updateBulk();
  $('#player').classList.add('hidden');
  $('#plFallback').classList.add('hidden');
  $('#plFallback').innerHTML = '';
  if (was && was !== next) heardFree(was);
}

async function play(e, list) {
  if (heard && heard.e.tk === e.tk) heard = null;   // dasselbe Lied nochmal: kein Überspringen
  endHeard();
  closePlayer(e.tk);
  const me = playing = { ...e, list, soul: list === 'tips' && soulOn };   // list: aus welchem Reiter das Lied kommt (für den Sprung per Klick auf den Player)
  heard = { e: me, sec: 0, pos: 0, started: false, done: false, na: false };
  const inHist = S.history.some((x) => x.tk === e.tk), wasHeard = isHeard(e.tk);
  addHistory(e);
  markHeard(e.tk);   // 0.9.59: sofort „gehört“, die Zeile bleibt an ihrem Platz
  markPlaying(); updateSkip();
  pauseBandcamp();   // auch für den Bandcamp-Player als Rückfall, der kein „play“ meldet
  $('#player').classList.remove('hidden');
  $('#plTitle').textContent = `${e.title || e.album} – ${e.artist}`;
  $('#plTime').textContent = t('lädt …');
  $('#plBtn').textContent = ''; $('#plBtn').classList.add('loading');
  let st;
  try { st = await streamFor(e); } catch (err) {
    if (playing !== me) return;
    // 0.9.58: Pre-Order ohne vorhörbaren Track – statt des leeren Bandcamp-Players den Release auf Bandcamp öffnen
    if (list === 'promos' && !err?.blocked && e.url) {
      heard = null;
      if (!inHist) { S.history = S.history.filter((x) => x.tk !== e.tk); store.set({ history: S.history }); }
      if (!wasHeard) { unmarkHeard(e.tk); for (const l of TAG_LISTS) { const li = rowOf(l, e.tk); li?.classList.remove('heard'); li?.querySelector('.heardb')?.remove(); } }
      closePlayer();
      toast(t('Noch nichts zum Vorhören – ich öffne den Release auf Bandcamp.'));
      openUrl(e.url);
      return;
    }
    // Rückfall: Bandcamp-Player
    if (heard?.e === me) heard.na = true;   // dort lässt sich nicht messen, wie lange du zuhörst
    $('#player').classList.add('hidden');
    $('#plFallback').innerHTML = `<iframe src="${esc(playerSrc(e))}" seamless></iframe>`;
    $('#plFallback').classList.remove('hidden');
    return;
  }
  if (playing !== me) return;
  $('#player')._dur = st.dur;
  audio.src = st.src;
  audio.play().catch(() => {});
  wavePeaks = null; $('#plBar').classList.add('wave'); drawWave();
  loadWave(st.src, e.tk).then((pk) => { if (playing === me) { wavePeaks = pk; drawWave(); } }).catch(() => {});
}
// Abgelaufener oder kaputter Stream: nicht weiter merken, einmal frisch holen, sonst auf den Bandcamp-Player ausweichen
audio.addEventListener('error', async () => {
  const e = playing, old = audio.getAttribute('src');
  if (!e || !old) return;
  streams.delete(e.url + '|' + (e.trackId || ''));
  if (!e.retried) {
    e.retried = true;
    const st = await streamFor(e).catch(() => null);
    if (playing !== e) return;
    if (st && st.src !== old) { audio.src = st.src; audio.play().catch(() => {}); return; }
  }
  if (playing !== e) return;
  if (heard?.e === e) heard.na = true;
  $('#player').classList.add('hidden');
  $('#plFallback').innerHTML = `<iframe src="${esc(playerSrc(e))}" seamless></iframe>`;
  $('#plFallback').classList.remove('hidden');
});

// ---------- Wellenform ----------
// Der Vorhör-Stream wird ein zweites Mal geladen und ausgewertet (Bandcamps Audio-Server, nicht die Bandcamp-Seiten:
// zählt nicht gegen das Anfrage-Limit). Bis die Wellenform da ist, zeigt der Player gleichmäßige flache Balken.
const waves = new Map();   // tk -> Promise<number[]> (400 Spitzenwerte 0..1)
let wavePeaks = null;
function loadWave(src, tk) {
  if (!waves.has(tk)) {
    const p = (async () => {
      const res = await fetch(src);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ab = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await res.arrayBuffer());
      const ch = ab.getChannelData(0), N = 400, step = ch.length / N, out = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        let m = 0;
        for (let j = Math.floor(i * step), end = Math.floor((i + 1) * step); j < end; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
        out[i] = m;
      }
      const max = Math.max(...out) || 1;
      return out.map((v) => Math.round((v / max) * 100) / 100);
    })();
    p.catch(() => waves.delete(tk));
    waves.set(tk, p);
    if (waves.size > 40) waves.delete(waves.keys().next().value);
  }
  return waves.get(tk);
}
function drawWave() {
  const cv = $('#plWave'), w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'), cs = getComputedStyle(cv);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const dur = audio.duration || $('#player')._dur || 0, played = dur ? (audio.currentTime / dur) * w : 0;
  const b = audio.buffered, buf = dur && b.length ? (b.end(b.length - 1) / dur) * w : 0;
  const bw = 2, gap = 1, n = Math.max(1, Math.floor((w + gap) / (bw + gap))), pk = wavePeaks;
  for (let i = 0; i < n; i++) {
    let v = 0.16;
    if (pk) { v = 0; for (let k = Math.floor((i / n) * pk.length), e = Math.max(k + 1, Math.floor(((i + 1) / n) * pk.length)); k < e; k++) v = Math.max(v, pk[k]); }
    const bh = Math.max(2, Math.round(v * h)), x = i * (bw + gap);
    if (x + bw / 2 <= played) { g.fillStyle = cs.color; g.globalAlpha = 1; }
    else { g.fillStyle = cs.borderTopColor; g.globalAlpha = x <= buf ? 0.6 : 0.32; }
    g.fillRect(x, h - bh, bw, bh);
  }
  g.globalAlpha = 1;
}
new ResizeObserver(() => drawWave()).observe($('#plWave'));
// Während das Lied läuft, flüssig nachzeichnen
(function waveLoop() { if (playing && !audio.paused) drawWave(); requestAnimationFrame(waveLoop); })();

function updatePlayer() {
  if (!playing) return;
  updateSkip(); drawWave();
  const dur = audio.duration || $('#player')._dur || 0, pb = $('#plBtn');
  pb.classList.toggle('loading', audio.readyState < 2 && !audio.error && !!audio.getAttribute('src'));
  pb.textContent = pb.classList.contains('loading') ? '' : audio.paused ? '▶' : '❚❚';
  pb.classList.toggle('paused', audio.paused && !pb.classList.contains('loading'));
  const lbl = t(audio.paused ? 'Abspielen' : 'Pause');
  pb.title = lbl; pb.setAttribute('aria-label', lbl);
  $('#plTime').textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(dur)}`;
  const bar = $('#plBar');
  bar.setAttribute('aria-valuemax', String(Math.round(dur))); bar.setAttribute('aria-valuenow', String(Math.round(audio.currentTime)));
  bar.setAttribute('aria-valuetext', $('#plTime').textContent);
  $('#plProg').style.width = dur ? `${(audio.currentTime / dur) * 100}%` : '0';
  const b = audio.buffered;
  $('#plBuf').style.width = dur && b.length ? `${(b.end(b.length - 1) / dur) * 100}%` : '0';
}
['timeupdate', 'progress', 'play', 'pause', 'loadedmetadata', 'seeked', 'canplay', 'waiting'].forEach((ev) => audio.addEventListener(ev, updatePlayer));
$('#plBtn').addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
// Vorheriges/nächstes Lied aus derselben Liste, aus der das laufende Lied stammt (Lieder ohne Link werden übersprungen)
function neighbor(dir) {
  if (!playing) return null;
  const list = cacheOf(playing.list);
  let i = list.findIndex((x) => x.tk === playing.tk);
  if (i < 0) return null;
  for (i += dir; i >= 0 && i < list.length; i += dir) if (list[i].url) return list[i];
  return null;
}
function skip(dir) { const e = neighbor(dir); if (e) play(e, playing.list); }
function updateSkip() { $('#plPrev').disabled = !neighbor(-1); $('#plNext').disabled = !neighbor(1); }
$('#plPrev').addEventListener('click', () => skip(-1));
$('#plNext').addEventListener('click', () => skip(1));
// Lied zu Ende: mit dem Lied darunter weitermachen
audio.addEventListener('ended', () => { if (neighbor(1)) skip(1); });
// Startet TrackPilot ein Lied, hält Bandcamp in den offenen Tabs an
function pauseBandcamp() {
  chrome.tabs.query({ url: ['https://bandcamp.com/*', 'https://*.bandcamp.com/*'] }).then((tabs) => {
    for (const tb of tabs) chrome.tabs.sendMessage(tb.id, { type: 'pauseMedia' }).catch(() => {});
  }).catch(() => {});
}
audio.addEventListener('play', pauseBandcamp);
// … und umgekehrt: spielt Bandcamp in einem Tab, pausiert TrackPilot
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'bcPlaying') return;
  if (!audio.paused) audio.pause();
  if (!$('#plFallback').classList.contains('hidden')) closePlayer();   // der Bandcamp-Player als Rückfall lässt sich nicht anhalten, nur schließen
});
$('#plClose').addEventListener('click', () => closePlayer());
// Laufendes Lied in seiner Liste leicht hervorheben
let flashUntil = 0;   // Aufleuchten übersteht auch ein Neuzeichnen der Liste (z. B. wenn Tags nachgeladen werden)
function markPlaying() {
  document.querySelectorAll('.item.playing').forEach((li) => li.classList.remove('playing'));
  document.querySelectorAll('button[data-play][aria-pressed="true"]').forEach((b) => { b.setAttribute('aria-pressed', 'false'); b.textContent = '▶'; });
  if (!playing) return;
  for (const [list, cache] of [['tips', tipsCache], ['scouts', scoutCache], ['promos', promoCache], ['hidden', hiddenCache], ['history', historyCache]]) {
    const i = cache.findIndex((x) => x.tk === playing.tk);
    const li = i >= 0 && $(`button[data-list="${list}"][data-play="${i}"]`)?.closest('.item');
    if (!li) continue;
    li.classList.add('playing');
    const pb = li.querySelector('[data-play]');   // der Knopf der laufenden Zeile pausiert statt neu zu starten
    pb.setAttribute('aria-pressed', 'true'); pb.textContent = audio.paused && audio.getAttribute('src') ? '▶' : '❚❚';
    if (Date.now() < flashUntil && !li.classList.contains('flash')) li.classList.add('flash');
  }
}
['play', 'pause'].forEach((ev) => audio.addEventListener(ev, markPlaying));
// Die Fenster „Wiedergabeverlauf“ und „Ausgeblendete Lieder“ enden über dem Player (auch über dem Bandcamp-Player als Rückfall)
{
  const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--plh', `${Math.ceil($('#player').getBoundingClientRect().height + $('#plFallback').getBoundingClientRect().height)}px`));
  ro.observe($('#player')); ro.observe($('#plFallback'));
}
// Klick auf Titel/Zeit im Player: in den Reiter des Liedes wechseln, hinscrollen und kurz aufleuchten lassen
const cacheOf = (list) => ({ tips: tipsCache, scouts: scoutCache, promos: promoCache, hidden: hiddenCache, history: historyCache })[list] || [];
const rowOf = (list, tk) => { const i = cacheOf(list).findIndex((x) => x.tk === tk); return i >= 0 ? $(`button[data-list="${list}"][data-play="${i}"]`)?.closest('.item') : null; };
$('.pl-top').addEventListener('click', () => {
  if (!playing) return;
  // Fenster „Wiedergabeverlauf“/„Ausgeblendete Lieder“ offen: dort hinscrollen
  const dlg = historyOpen() ? 'history' : hiddenOpen() ? 'hidden' : null;
  let list = dlg || playing.list || 'scouts', li = rowOf(list, playing.tk);
  if (!dlg) {
    // aus einem der Fenster gestartet: dorthin, wo das Lied in den Listen steht – sonst den Reiter nicht wechseln
    if (list === 'hidden' || list === 'history') list = ['tips', 'scouts', 'promos'].find((l) => rowOf(l, playing.tk)) || null;
    if (!list) { toast(t('Das Lied steht gerade in keiner Liste.')); return; }
    if (list === 'scouts' || list === 'promos') showTab(list);
    else { const tb = playing.soul ? 'soul' : 'match'; tabView[tb] = 'tracks'; showTab(tb); }   // Trackliste des Reiters, aus dem das Lied kommt
    li = rowOf(list, playing.tk);
  }
  if (!li) { toast(t('Das Lied steht gerade nicht in der Liste (Tag-Filter?).')); return; }
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flashUntil = Date.now() + 1600;
  li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
});
{
  const bar = $('#plBar');
  const seek = (ev) => {
    const r = bar.getBoundingClientRect();
    const dur = audio.duration || $('#player')._dur;
    if (dur) audio.currentTime = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * dur;
  };
  bar.addEventListener('pointerdown', (ev) => {
    bar.setPointerCapture(ev.pointerId);
    seek(ev);
    bar.addEventListener('pointermove', seek);
    bar.addEventListener('pointerup', () => bar.removeEventListener('pointermove', seek), { once: true });
  });
}
document.addEventListener('keydown', (e) => {
  if (!playing || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.getAttribute?.('role') === 'tab') return;
  if (e.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 10); e.preventDefault(); }
});

// ---------- Tags ----------
// Bandcamp liefert Tags nur auf der Release-Seite. Sie werden im Hintergrund nachgeladen – mit niedriger Priorität,
// also nur wenn gerade keine Fan-Suche läuft – und dauerhaft gemerkt.
const TAG_DAYS = 60, TAG_LOOKAHEAD = 100, TAG_LOOKAHEAD_FILTERED = 300;   // mit aktivem Filter weiter vorausladen
const tagKey = (url) => { try { const x = new URL(url); return x.origin + x.pathname; } catch { return ''; } };
const normTag = (t) => norm(t).replace(/^#/, '');
function tagsFromDoc(doc) {
  const out = new Set();
  doc.querySelectorAll('.tralbum-tags a.tag, a.tag').forEach((a) => { const t = normTag(a.textContent); if (t) out.add(t); });
  if (!out.size) {
    for (const sc of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { const kw = JSON.parse(sc.textContent).keywords; (Array.isArray(kw) ? kw : String(kw || '').split(',')).forEach((t) => { t = normTag(t); if (t) out.add(t); }); } catch { /* egal */ }
    }
  }
  return [...out];
}
// 0.9.58: Pre-Order (pre 0/1) und Erscheinungsdatum (rd, ms; 0 = unbekannt) – aus data-tralbum, sonst ld+json datePublished
function relInfo(doc) {
  let tr = {};
  try { tr = JSON.parse(doc.querySelector('script[data-tralbum]')?.getAttribute('data-tralbum') || '{}') || {}; } catch { /* egal */ }
  const when = (v) => { const x = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v || ''); return x > 0 ? x : 0; };
  let rd = when(tr.album_release_date) || when(tr.current?.release_date) || when(tr.current?.publish_date);
  if (!rd) {
    for (const sc of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { rd = when(JSON.parse(sc.textContent).datePublished); } catch { /* egal */ }
      if (rd) break;
    }
  }
  return { pre: tr.is_preorder || tr.album_is_preorder || tr.current?.is_preorder ? 1 : 0, rd };
}
const tagsOf = (e) => S.tags[tagKey(e.url)]?.t || null;
let tagsDirty = 0, tagVer = 0;   // tagVer: steigt mit jedem gemerkten Tag-Satz (Zwischenspeicher Ortsnamen, Geschmack)
function saveTags(url, tags, failed, info) {
  const k = tagKey(url);
  if (!k) return;
  tagVer++;
  // 0.9.59: schlägt der Abruf fehl, bleiben schon bekannte Tags und Erscheinungsdaten erhalten (nur err für den Neuversuch)
  const old = failed ? S.tags[k] : null;
  S.tags[k] = { t: old?.t?.length ? old.t : tags, at: Date.now(), ...(failed ? { err: 1 } : {}),
    ...(info ? { pre: info.pre, rd: info.rd } : old?.rd != null ? { pre: old.pre, rd: old.rd } : {}) };
  if (!failed) delete S.tags[k].err;
  if (++tagsDirty >= 5) flushTags();
}
function flushTags() { tagsDirty = 0; store.set({ tags: S.tags }); }

const tagQueue = [], tagQueued = new Set();
let tagWorkerOn = false, tagRenderAt = 0;
function needTags(list, n = TAG_LOOKAHEAD) {
  for (const e of list.slice(0, n)) {
    const k = tagKey(e.url), have = S.tags[k];
    if (!k || tagQueued.has(k) || (have && Date.now() - have.at < (have.err ? 1 : TAG_DAYS) * 864e5)) continue;
    tagQueued.add(k); tagQueue.push(k);
  }
  if (!tagWorkerOn && tagQueue.length) tagWorker();
}
async function tagWorker() {
  tagWorkerOn = true;
  while (tagQueue.length) {
    if (cur?.scanning || scoutsRunning || soulRunning || (pre && !pre.ready && pre.url === pending?.url)) { await sleep(1000); continue; }   // Fan-Suche geht vor
    const k = tagQueue.shift();
    try {
      const doc = await getHtml(k, true);
      saveTags(k, tagsFromDoc(doc), false, relInfo(doc));   // 0.9.58: Pre-Order und Erscheinungsdatum aus derselben Seite
    } catch (e) {
      // Während einer Sperre nicht als „keine Tags“ merken (sonst fehlen die Lieder einen Tag lang im Tag-Filter): danach neu versuchen
      if (e.blocked) { tagQueue.unshift(k); await sleep(Math.max(1000, blockedUntil - Date.now())); continue; }
      saveTags(k, [], true);
    }
    tagQueued.delete(k);
    if (Date.now() - tagRenderAt > 1500 || !tagQueue.length) { tagRenderAt = Date.now(); renderTips(); renderScouts(); renderPromos(); }
  }
  flushTags();
  tagWorkerOn = false;
}

// 0.9.66: Genre-Filter für alle Tracklisten (Aktueller Track · Tracks, Für Dich · Tracks, Gefolgt, Promos), nur in den Einstellungen.
// „Nur diese Genres zeigen“ (eins davon muss passen) und „Diese Genres ausblenden“ (ein solcher Tag am Lied blendet es immer aus).
// Vorschläge dort: die häufigsten Tags der Tracklisten zusammen (vorher je Liste eine Tag-Leiste über der Liste).
const renderList = (listName) => (listName === 'tips' ? renderTips() : listName === 'promos' ? renderPromos() : renderScouts());
const tagCounts = {}, tagLoad = {};   // je Liste: Tag → Anzahl unter den ersten TAG_LOOKAHEAD, noch ohne Tags
const tagSets = () => ({ inc: new Set(S.settings.tagFilter || []), exc: new Set(S.settings.tagExclude || []) });
const tagFilterOn = () => !!(S.settings.tagFilter?.length || S.settings.tagExclude?.length);
// applyTagFilter(listName, all): Signatur wie bisher, es gelten die globalen Listen
function applyTagFilter(listName, all) {
  const { inc, exc } = tagSets();
  needTags(all, inc.size || exc.size ? TAG_LOOKAHEAD_FILTERED : TAG_LOOKAHEAD);
  const count = new Map(), head = all.slice(0, TAG_LOOKAHEAD);
  for (const e of head) for (const t of tagsOf(e) || []) count.set(t, (count.get(t) || 0) + 1);
  tagCounts[listName] = count;
  tagLoad[listName] = { known: head.filter((e) => tagsOf(e)).length, all: head.length };
  if (!$('#settings').classList.contains('hidden')) renderGenres();
  if (!inc.size && !exc.size) return all;
  return all.filter((e) => {
    const tags = tagsOf(e);
    if (!tags) return !inc.size;                       // Tags noch unbekannt: nur bei reinem Ausschließen vorerst zeigen
    if (tags.some((t) => exc.has(t))) return false;
    return !inc.size || tags.some((t) => inc.has(t));
  });
}
// Filter ändern = alle Tracklisten bewusst neu sortieren (0.9.59)
function saveTagSets(inc, exc) {
  S.settings.tagFilter = [...inc];
  S.settings.tagExclude = [...exc];
  store.set({ settings: S.settings });
  unfreeze();
  renderTips(); renderScouts(); renderPromos();
  renderGenres();
}
function addGenre(mode, tags) {
  const { inc, exc } = tagSets();
  for (const t of tags) { if (mode === 'exc') { inc.delete(t); exc.add(t); } else { exc.delete(t); inc.add(t); } }
  saveTagSets(inc, exc);
}
// Eingabefeld: beliebige Tags, mehrere mit Komma; ein Minus davor blendet aus
function addTypedTag(mode) {
  const input = $(mode === 'exc' ? '#genreExcIn' : '#genreIncIn');
  let raw = input.value.trim();
  if (raw.startsWith('-')) { mode = 'exc'; raw = raw.slice(1); }
  const tags = raw.split(',').map(normTag).filter(Boolean);
  if (!tags.length) return;
  input.value = '';
  addGenre(mode, tags);
}
const genreTitle = () => {
  const { inc, exc } = tagSets();
  return [inc.size ? t('Nur: {tags}', { tags: [...inc].join(', ') }) : '', exc.size ? t('Ohne: {tags}', { tags: [...exc].join(', ') }) : ''].filter(Boolean).join(' · ');
};
// Abschnitt „Genres“ in den Einstellungen
function renderGenres() {
  if (!$('#genreSec')) return;
  const { inc, exc } = tagSets();
  const chips = (set, mode) => [...set].map((x) => `<button class="chip ${mode === 'inc' ? 'on' : 'off'}" data-grm="${mode}" data-tag="${esc(x)}" title="${esc(t('Entfernen'))}" aria-label="${esc(t('{tag} entfernen', { tag: x }))}">${mode === 'exc' ? '− ' : ''}${esc(x)} <span aria-hidden="true">×</span></button>`).join('');
  $('#genreInc').innerHTML = chips(inc, 'inc');
  $('#genreExc').innerHTML = chips(exc, 'exc');
  const count = new Map();
  for (const c of Object.values(tagCounts)) for (const [k, n] of c) count.set(k, (count.get(k) || 0) + n);
  const top = [...count].filter(([k]) => !inc.has(k) && !exc.has(k)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  $('#genreSugg').innerHTML = top.map((x) => `<span class="gsug"><button class="chip" data-gadd="inc" data-tag="${esc(x)}" title="${esc(t('Nur dieses Genre zeigen'))}">+ ${esc(x)}</button>`
    + `<button class="chip gx" data-gadd="exc" data-tag="${esc(x)}" title="${esc(t('Dieses Genre ausblenden'))}" aria-label="${esc(t('{tag} ausblenden', { tag: x }))}">−</button></span>`).join('')
    || `<span class="muted small">${t('Noch keine Tags in deinen Listen.')}</span>`;
  const ld = Object.values(tagLoad).reduce((a, x) => ({ known: a.known + x.known, all: a.all + x.all }), { known: 0, all: 0 });
  $('#genreLoad').textContent = ld.all > ld.known ? t('Tags werden geladen ({known} von {all})', ld) : '';
  $('#genreClear').classList.toggle('hidden', !inc.size && !exc.size);
}
function onGenreClick(ev) {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.id === 'genreClear') { saveTagSets([], []); return; }
  if (b.dataset.gadd && b.dataset.tag) { addGenre(b.dataset.gadd, [b.dataset.tag]); return; }
  if (b.dataset.grm) {
    const { inc, exc } = tagSets();
    (b.dataset.grm === 'exc' ? exc : inc).delete(b.dataset.tag);
    saveTagSets(inc, exc);
    $(b.dataset.grm === 'exc' ? '#genreExcIn' : '#genreIncIn').focus();   // der Chip selbst verschwindet
  }
}
// Hinweis „Genre-Filter aktiv“ in der Zeile über der Liste: öffnet die Einstellungen beim Abschnitt
function openGenres() {
  showSettings(true);
  $('#genreSec').scrollIntoView({ block: 'start' });
  $('#genreIncIn').focus({ preventScroll: true });
}
// Vorschläge beim Tippen: alle bisher bekannten Tags
function fillTagSuggestions() {
  const all = new Set();
  for (const v of Object.values(S.tags)) for (const t of v.t || []) all.add(t);
  $('#tagSuggest').innerHTML = [...all].sort().map((t) => `<option value="${esc(t)}">`).join('');
}

// ---------- Auf die Bandcamp-Wishlist setzen (♥) ----------
// Nutzt dieselbe Funktion wie das Herz auf der Bandcamp-Seite. Klappt das nicht, öffnet sich die Seite zum Selbstklicken.
const tralbumOf = (doc) => { try { return JSON.parse(doc.querySelector('script[data-tralbum]')?.getAttribute('data-tralbum') || '{}'); } catch { return {}; } };
// Link zur Track-Seite: Einzeltracks haben ihn schon, bei Alben steht er in der Titelliste der Album-Seite (title_link)
const trackUrls = new Map();
function trackLinkFrom(doc, e) {
  const tr = (tralbumOf(doc).trackinfo || []).find((x) => String(x.track_id ?? x.id) === String(e.trackId));
  trackUrls.set(e.tk, tr?.title_link ? new URL(tr.title_link, e.url).href : e.url);   // auch „kein Link“ merken: nicht nochmal laden
}
async function trackUrl(e, doc = null) {
  if (e.tk[0] !== 't' || /\/track\//.test(e.url)) return e.url;
  if (!trackUrls.has(e.tk)) trackLinkFrom(doc || await getHtml(e.url), e);
  return trackUrls.get(e.tk) || e.url;
}

// Setzt genau den Track (nicht das ganze Album) auf deine Wishlist – über dieselbe Funktion wie das Herz auf der Track-Seite
async function setWishlist(e, add) {
  if (!S.me?.fanId) throw new Error(t('eigene Wishlist nicht geladen'));
  let url = e.url, doc = await getHtml(url);
  if (e.tk[0] === 't' && !/\/track\//.test(url)) {
    url = await trackUrl(e, doc);
    if (url === e.url) throw new Error(t('Track-Seite nicht gefunden'));
    doc = await getHtml(url);
  }
  const tr = tralbumOf(doc);
  let band = {};
  try { band = JSON.parse(doc.querySelector('script[data-band]')?.getAttribute('data-band') || '{}'); } catch { /* egal */ }
  const crumbs = JSON.parse(doc.querySelector('#js-crumbs-data')?.getAttribute('data-crumbs') || '{}');
  const ep = add ? 'collect_item_cb' : 'uncollect_item_cb';
  const type = tr.item_type || (e.tk[0] === 't' ? 'track' : 'album');
  const body = { fan_id: S.me.fanId, item_id: tr.id || e.tk.slice(1), item_type: type, band_id: tr.current?.band_id || band.id || '', crumb: crumbs[ep] || '' };
  if (!body.item_id || !body.band_id) throw new Error(t('Release-Daten fehlen'));
  const origin = new URL(url).origin;
  let lastErr = 'abgelehnt';
  // Bandcamps Seite schickt den Typ ausgeschrieben („track“); ältere Varianten nehmen das Kürzel – beides probieren
  for (const it of [type, type[0]]) {
    body.item_type = it;
    for (let i = 0; i < 2; i++) {
      const res = await request(`${origin}/${ep}`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }, 'json');
      if (res.ok) return;
      lastErr = res.error || JSON.stringify(res).slice(0, 120);
      if (res.crumb && i === 0) { body.crumb = res.crumb; continue; }   // abgelaufenes Crumb: einmal neu versuchen
      break;
    }
  }
  throw new Error(lastErr);
}

// Zweiter Weg: Track-Seite unsichtbar in einem Hintergrund-Tab öffnen, dort Bandcamps Herz anklicken, Tab wieder schließen
async function likeViaTab(url, add) {
  const tab = await chrome.tabs.create({ url, active: false });
  likeTabs(tab.id, true);
  try {
    for (let i = 0; i < 100; i++) {
      const tb = await chrome.tabs.get(tab.id).catch(() => null);
      if (!tb) throw new Error(t('Tab geschlossen'));
      if (tb.status === 'complete') break;
      await sleep(200);
    }
    let res = null;
    for (let i = 0; i < 10 && !res; i++) {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'wishlist', add }).catch(() => null);
      if (!res) await sleep(300);
    }
    if (!res?.ok) throw new Error(t(res?.error || 'Seite antwortet nicht'));   // content.js meldet deutsch
  } finally { chrome.tabs.remove(tab.id).catch(() => {}); likeTabs(tab.id, false); }
}
// Offene Hintergrund-Tabs merken (Tab → Fenster dieser Leiste): geht die Leiste mittendrin zu, schließt der Hintergrund sie (background.js).
// Nacheinander schreiben, sonst überschreiben sich zwei gleichzeitige Herz-Klicks.
let myWindowId = null, likeTabsQ = Promise.resolve();
function likeTabs(id, add) {
  return (likeTabsQ = likeTabsQ.then(async () => {
    let all = (await chrome.storage.session.get('likeTabs')).likeTabs;
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    if (add) all[id] = myWindowId; else delete all[id];
    await chrome.storage.session.set({ likeTabs: all });
  }).catch(() => {}));
}
// Beim Start: Reste einer vorher geschlossenen Leiste in diesem Fenster schließen
function cleanLikeTabs() {
  return (likeTabsQ = likeTabsQ.then(async () => {
    const all = (await chrome.storage.session.get('likeTabs')).likeTabs;
    if (!all || typeof all !== 'object' || Array.isArray(all)) return;
    const ids = Object.keys(all).filter((id) => all[id] === myWindowId);
    if (!ids.length) return;
    for (const id of ids) { chrome.tabs.remove(Number(id)).catch(() => {}); delete all[id]; }
    await chrome.storage.session.set({ likeTabs: all });
  }).catch(() => {}));
}

const liking = new Set();   // Herzen, deren Änderung gerade läuft (die Listen werden währenddessen neu gezeichnet)
async function toggleLike(e) {
  if (liking.has(e.tk)) return;
  const add = !S.liked[e.tk];
  // Die Listen werden neu gezeichnet: der Tastaturfokus bleibt auf dem Herz dieses Liedes
  const fl = document.activeElement?.closest?.('button[data-like]')?.dataset.list;
  const refocus = () => {
    if (!fl || document.activeElement !== document.body) return;
    const i = cacheOf(fl).findIndex((x) => x.tk === e.tk);
    if (i >= 0) $(`button[data-list="${fl}"][data-like="${i}"]`)?.focus();
  };
  liking.add(e.tk); renderTips(); if (!scoutsRunning) renderScouts(); renderPromos(); if (historyOpen()) renderHistory();   // laufende Tracksuche zeichnet ihre Liste selbst (mit Fortschritt)
  refocus();
  try {
    try { await setWishlist(e, add); } catch (err) {
      log(t('Wishlist-Änderung fehlgeschlagen ({err}): {url}', { err: 'API: ' + err.message, url: e.url }));
      const url = await trackUrl(e);
      if (e.tk[0] === 't' && !/\/track\//.test(url)) throw new Error(t('Track-Seite nicht gefunden'));   // nie das ganze Album auf die Wishlist
      await likeViaTab(url, add);
    }
    if (add) S.liked[e.tk] = Date.now(); else delete S.liked[e.tk];
    await store.set({ liked: S.liked });
    if (add) addTaste(e, 'like'); else removeTaste([e.tk], 'like');   // 0.9.56: Geschmacks-Signal (♥ zurückgenommen: Signal weg)
    toast(t(add ? '„{t}“ steht jetzt auf deiner Wishlist.' : '„{t}“ von der Wishlist entfernt.', { t: e.title || e.album }));
  } catch (err) {
    log(t('Wishlist-Änderung fehlgeschlagen ({err}): {url}', { err: err.message, url: e.url }));
    toast(t('Hat nicht geklappt. Ich öffne die Seite, dort kannst du auf das Herz klicken.'));
    openUrl(await trackUrl(e).catch(() => e.url));   // direkt die Track-Seite, nicht das Album
  }
  liking.delete(e.tk); renderTips(); if (!scoutsRunning) renderScouts(); renderPromos(); if (historyOpen()) renderHistory();
  refocus();
}

// Im Bandcamp-Tab links öffnen; ist dort gerade eine andere Seite offen, lieber einen neuen Tab nehmen
function openUrl(url) {
  (curTabId != null && curTabBc ? chrome.tabs.update(curTabId, { url }) : chrome.tabs.create({ url })).catch(() => chrome.tabs.create({ url }));
}

// ---------- Darstellung ----------
let statusText = '';
function setStatus(t) { statusText = t; $('#status').textContent = t; }
function log(t) {
  const el = $('#log');
  el.textContent = `${new Date().toLocaleTimeString(locale())}  ${t}\n` + el.textContent.slice(0, 20000);
}
let toastTimer;
function toast(t, ms = 3000) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
const fmtWeeks = (d) => (d >= 0 ? '+' : '−') + t('{n} Wo.', { n: Math.abs(Math.round(d / 7)) });

// 0.9.68: Setup-Karte mit Hinweis: angemeldet erkannt (Name vorausgefüllt), abgemeldet, Fehler beim Laden oder wo der Name steht
let setupErr = '';
function renderSetup() {
  $('#setup').classList.toggle('hidden', !!S.me);
  if (S.me) return;
  const inp = $('#setupUser');
  if (meGuess?.user && !inp.value) inp.value = meGuess.user;   // nie überschreiben, was du schon getippt hast
  $('#setupHint').textContent = setupErr || (meGuess?.user ? t('Bei Bandcamp angemeldet als {user} – drück auf „Wishlist laden“.', { user: meGuess.user })
    : meGuess?.out ? t('Du bist bei Bandcamp nicht angemeldet. Melde dich bei Bandcamp an und lade das Panel neu – oder trag deinen Namen hier ein.')
    : t('Deinen Namen siehst du in der Adresse deiner Sammlung: bandcamp.com/deinname'));
}
// Angemeldeten Bandcamp-Namen aus der links offenen Bandcamp-Seite lesen (Bandcamps Seitendaten, keine Anfrage).
// meGuess: { user } angemeldet, { out: true } abgemeldet, null unbekannt (keine Bandcamp-Seite, Seite ohne diese Daten)
let meGuess = null;
async function guessMe() {
  if (S.me || curTabId == null || !curTabBc) return;
  const m = await chrome.tabs.sendMessage(curTabId, { type: 'getHtml' }).catch(() => null);
  if (!m?.html || S.me) return;
  const doc = new DOMParser().parseFromString(m.html, 'text/html');
  for (const el of doc.querySelectorAll('[data-blob]')) {
    let b = null;
    try { b = JSON.parse(el.getAttribute('data-blob')); } catch { continue; }
    const id = b?.identities;
    if (!id || typeof id !== 'object') continue;
    const u = id.fan?.username || userFromHref(id.fan?.url || '');
    meGuess = u ? { user: String(u) } : { out: true };
    renderSetup();
    return;
  }
}

function renderMe() {
  if (!S.me) { $('#meInfo').textContent = t('Noch keine Wishlist geladen.'); return; }
  const n = Object.values(fans).filter((f) => !f.error).length;
  $('#meInfo').textContent = t('{user}: {n} Releases · {f} Fan-Profile gespeichert · Stand {date}', { user: S.me.username, n: S.me.keys.length, f: n, date: new Date(S.me.loadedAt).toLocaleDateString(locale()) });
}

function clearNow() {
  $('#nowCover').outerHTML = '<div class="cover" id="nowCover"></div>';
  $('#nowTitle').textContent = t(pending ? 'Noch kein Release ausgelesen' : curTabBc ? 'Kein Album oder Track offen' : 'Keine Bandcamp-Seite offen');   // 0.9.68: Bandcamp ohne Release
  $('#nowArtist').textContent = '';
}
function renderNow() {
  if (!cur) return clearNow();
  const c = $('#nowCover');
  c.outerHTML = pic('cover', coverUrl(cur.art), cur.title || '?').replace('class="cover"', 'class="cover" id="nowCover"');
  $('#nowTitle').textContent = nowTrack || cur.title || t('Lädt …');
  $('#nowArtist').textContent = [cur.artist, nowTrack && cur.title !== nowTrack ? cur.title : ''].filter(Boolean).join(' · ');
}

// Übereinstimmungen: Fans des offenen Releases, nach Scout-Score
// Mit „Nächste 50“ dazugekommen: steht in der Käuferliste hinter dem vorherigen Stand
const isNewFan = (u) => { if (cur?.newFrom == null) return false; const i = cur.fans.indexOf(u); return i >= cur.newFrom && i < cur.limit; };
function renderMatches() {
  renderAction();
  const el = $('#matchList');
  if (!S.me && !cur?.scanning) { el.innerHTML = `<li class="empty">${t(NEED_ME)}</li>`; return; }   // 0.9.68: erst die eigene Sammlung
  if (!cur) { el.innerHTML = `<li class="empty">${t(pending ? 'Drück oben auf „Suche starten“.' : 'Öffne links ein Album oder einen Track auf Bandcamp')}</li>`; return; }
  if (cur.error) { el.innerHTML = `<li class="empty">${t('Dieser Release ließ sich nicht lesen ({err}).', { err: esc(cur.error) })}</li>`; return; }
  if (!S.me) { el.innerHTML = `<li class="empty">${t(NEED_ME)}</li>`; return; }
  computeAll();
  const { minTotal, minMatch } = S.settings;
  const list = cur.fans.map((u) => fans[u]).filter((f) => f && !f.error && f.total >= minTotal && f.m >= minMatch)
    // erst Überschneidungen, dann wie viel früher der Fan die gemeinsamen Releases hatte, zuletzt der Scout-Score
    .sort((a, b) => (b.m - a.m) || ((b.leadMed ?? -1e9) - (a.leadMed ?? -1e9)) || (b.sc - a.sc));
  const more = !cur.scanning && (cur.total > cur.limit || cur.more)
    ? `<li class="moreRow"><span class="muted small">${t(cur.more ? '{a} von mehr als {b} geprüft' : '{a} von {b} geprüft', { a: Math.min(cur.done, cur.limit), b: cur.total })}</span></li>` : '';
  el.innerHTML = ((list.length ? `<li class="listhead"><span>${t('Fan')}</span><button class="info" id="rankInfo" title="${esc(rankHelp())}">${t('Rang')} <span class="i" aria-hidden="true">ⓘ</span></button></li>` : '')
    + list.map((f, i) => fanItem(f, i, f.m, isNewFan(f.u))).join('')
    || `<li class="empty">${t(cur.scanning ? 'Suche läuft …' : cur.total ? 'Keiner der Fans dieses Releases passt gut zu deiner Wishlist.' : 'Dieser Release hat noch keine sichtbaren Unterstützer.')}</li>`)
    + more;
}

// Eine Fan-Zeile (Fanvorschläge und Seelenverwandte)
function fanItem(f, i, m, isNew = false, newTitle = t('Mit „Nächste 50“ neu dazugekommen')) {
  const seen = !!S.visited?.[f.u];
  return `<li class="item${isFollowed(f.u) ? ' followed' : ''}${isNew ? ' newfan' : ''}${seen ? ' visited' : ''}">
    <button class="open" data-fan="${esc(f.u)}" title="${isFollowed(f.u) ? t('Du folgst diesem Fan schon · ') : ''}${seen ? t('Schon besucht · ') : ''}${t('Profil öffnen')}">
      ${pic('av', avatarUrl(f.img), f.name || f.u)}
      <span class="txt"><span class="a"><span class="nm">${esc(f.name || f.u)}</span>${isFollowed(f.u) ? `<b class="fol">${t('✓ du folgst')}</b>` : ''}${isNew ? `<b class="newb" title="${esc(newTitle)}">${t('neu')}</b>` : ''}</span>
        <span class="b">${t('{n} gemeinsam', { n: m })}${f.unchk ? ` · <span class="unchk" title="${esc(t('Bisher nur über die Käuferlisten deiner Releases gefunden. Eine spätere Suche lädt noch die Käufe dieses Fans, dann können es mehr gemeinsame werden.'))}">${t('noch nicht geprüft')}</span>` : leadText(f) ? ' · ' + leadText(f) : ''}${f.cut ? ` · <span class="cut" title="${esc(t('kauft gerade anderes – bei den neuesten 60 Käufen kaum Überschneidung'))}">${t('kauft gerade anderes')}</span>` : ''}</span></span>
      <span class="score rank">${i + 1}</span>
    </button></li>`;
}
// 0.9.50: neu bei „Für Dich“ = im letzten Durchgang dazugekommen (nach dem allerersten Durchgang ist noch niemand „neu“)
function isSoulNew(u) {
  const run = S.soul.run || 0, at = S.soul.seen?.[u];
  return at == null ? run >= 1 : at === run && run > 1;
}
// Seelenverwandte: Fans über alle deine Releases statt nur über den offenen
// 0.9.53: Die Liste kann sehr lang werden (jeder mit ≥ 2 Treffern) – gezeigt werden erst 200, „Weitere zeigen“ holt mehr
const SOUL_PAGE = 200;
let soulShow = SOUL_PAGE;
function renderSoul() {
  if (!soulOn) return;
  renderAction();
  // 0.9.72: Fortschritt als eigene Zeile über der Liste (vorher Fußzeile), bei Fans und Tracks
  const done = S.me ? Object.keys(S.soul.seeds).filter(seedFresh).length : 0, all = (S.me?.keys || []).length;
  $('#soulProg').textContent = done ? t('{a} von {b} deiner Releases durchsucht', { a: Math.min(done, all), b: all }) : '';
  if (tabView.soul !== 'fans') return;   // bei „Tracks“ ist die Fan-Liste nicht zu sehen
  const el = $('#soulList');
  if (!S.me) { el.innerHTML = `<li class="empty">${t(NEED_ME)}</li>`; return; }
  const list = soulList(), shown = list.slice(0, soulShow), rest = list.length - shown.length;
  const more = rest > 0 ? `<li class="moreRow"><button class="small" id="soulMore">${t('Weitere {n} zeigen', { n: Math.min(SOUL_PAGE, rest) })}</button> <span class="muted small">${t('{a} von {b} angezeigt', { a: shown.length, b: list.length })}</span></li>` : '';
  const newTitle = t(S.soul.runAuto ? 'Seit Start der Dauersuche neu dazugekommen' : 'Im letzten Durchgang neu dazugekommen');
  el.innerHTML = (list.length ? `<li class="listhead"><span>${t('Fan')}</span><button class="info" id="soulInfo" title="${esc(soulHelp())}">${t('Rang')} <span class="i" aria-hidden="true">ⓘ</span></button></li>`
    + shown.map((x, i) => fanItem(x.f, i, x.n, isSoulNew(x.f.u), newTitle)).join('') + more
    : `<li class="empty">${t(soulRunning ? 'Suche läuft …' : done ? 'Noch niemand mit mehreren gemeinsamen Releases. Oben weitere Releases durchsuchen.' : 'Findet Fans, die mehrere deiner Releases gekauft haben. Drück oben auf „Seelenverwandte suchen“.')}</li>`);
}
const soulHelp = () => t('Seelenverwandte: Fans, die mehrere deiner Releases gekauft haben – egal welcher Release links offen ist. Jede Suche liest die Käuferlisten deiner nächsten Releases (die neuesten zuerst), so viele Bandcamps Limit zulässt. Wer auf mindestens 2 davon steht, kommt sofort in die Liste („noch nicht geprüft“). Danach lädt die Suche von den besten die neuesten 200 Käufe; „Gemeinsam“ zählt dann alle Releases, die du und der Fan beide habt.');
// Reiter und Ansicht (Fans/Tracks) anzeigen
let shownView = '';   // 0.9.59: zuletzt gezeigter Reiter|Ansicht (setView ändert tabView schon vor showTab)
function showTab(tab, save = true) {
  const was = soulOn;
  realTab = TABS.includes(tab) ? tab : 'match';
  soulOn = realTab === 'soul';
  const sv = realTab + '|' + activeTab(), moved = sv !== shownView;
  if (moved) { unfreeze(); shownView = sv; closePpl(); }   // anderer Reiter bzw. Fans/Tracks: Listen neu sortieren
  document.querySelectorAll('.tabs button[data-tab]').forEach((x) => { const on = x.dataset.tab === realTab; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; });
  const view = activeTab();
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('hidden', el.id !== 'tab-' + view));
  document.body.classList.toggle('soul', soulOn);
  // Release-Karte, „Links geöffnet“ und Fortschritt gehören zu „Aktueller Track“ und „Für Dich“
  document.body.classList.toggle('on-match', view === 'match');
  document.body.classList.toggle('on-tips', view === 'tips');
  $('#viewFans').setAttribute('aria-pressed', String(view === 'match'));
  $('#viewTracks').setAttribute('aria-pressed', String(view === 'tips'));
  $('#matchList').classList.toggle('hidden', soulOn);
  $('#soulList').classList.toggle('hidden', !soulOn);
  if (was !== soulOn && !cur?.scanning && !soulRunning) setStatus('');
  // 0.9.53: wer „Für Dich · Tracks“ öffnet, bekommt die Kauflisten der besten 5 einmal von selbst frisch geladen
  const tr = soulOn && view === 'tips';
  if (tr && !shownTracks) tracksAuto = true;
  shownTracks = tr;
  renderSoul(); renderMatches(); renderTips(); renderPromos(); renderAction();
  if (moved && !scoutsRunning) renderScouts();   // laufende Suche zeichnet selbst (mit Fortschritt)
  if (save) saveView();
}
const rankHelp = () => t('Rang: Fans mit den meisten gemeinsamen Releases stehen oben. „Gemeinsam“ heißt, so viele Releases von deiner Wishlist hat der Fan auch gekauft. Bei Gleichstand gewinnt, wer sie früher hatte: „5 Wochen vor dir“ heißt, der Fan hat die gemeinsamen Releases meist 5 Wochen früher gekauft, als du sie auf deine Wishlist gesetzt hast. Solche Fans entdecken Musik vor dir.');
// „5 Wochen vor dir“: typischer Vorsprung (Median) des Fans bei den gemeinsamen Releases
function leadText(f) {
  if (f.leadMed == null) return '';
  const w = Math.round(f.leadMed / 7);
  if (w === 0) return t('etwa gleichzeitig mit dir');
  const n = Math.abs(w);
  return w > 0 ? t(n === 1 ? '1 Woche vor dir' : '{n} Wochen vor dir', { n }) : t(n === 1 ? '1 Woche nach dir' : '{n} Wochen nach dir', { n });
}

// Zeile 1 Titel, Zeile 2 Künstler · Album, Zeile 3 wie viele Fans es haben (wonach sortiert ist, wird nie abgeschnitten) und „gehört“;
// 0.9.66: Promos mit eigener Zeile für Datum/Status davor (info = { st, cnt }; bei schmaler Leiste Umbruch nur am „·“);
// Tags darunter, bis 10, höchstens 2 Zeilen
const ROW_TAGS = 10;
function trackItem(e, i, list, info, hide = true) {
  const st = typeof info === 'object' ? info.st : '', cnt = typeof info === 'object' ? info.cnt : info;
  const on = !!S.liked[e.tk], hd = TAG_LISTS.includes(list) && isHeard(e.tk);   // 0.9.59: „gehört“ nur in den Tracklisten
  // 0.9.66: in Promos und Gefolgt öffnet auch der Zähltext („bei N deiner Leute“) das Leute-Fenster – dann ohne Namens-Tooltip
  const pplRow = (list === 'promos' || list === 'scouts') && e.byU?.length;
  return `<li class="item${hd ? ' heard' : ''}">
    <button class="open" data-list="${list}" data-open="${i}" title="${t('Auf Bandcamp öffnen')}">
      ${pic('cover', coverUrl(e.art), e.album || e.title)}
      <span class="txt"><span class="a">${e.title ? esc(e.title) : esc(e.album)}</span>
        <span class="b">${esc(e.artist)}${e.title && e.album ? ' · ' + esc(e.album) : ''}</span>
        ${st ? `<span class="st">${st.split(' · ').map((x) => `<span class="nw">${esc(x)}</span>`).join(' · ')}</span>` : ''}<span class="tags"><b class="cnt"${pplRow ? ` data-pplc="${i}"` : ''}${e.why && list !== 'promos' ? ` title="${esc(e.why)}"` : ''}>${esc(cnt)}</b>${hd ? heardBadge() : ''}</span>
        ${tagsOf(e)?.length ? `<span class="tg">${tagsOf(e).slice(0, ROW_TAGS).map(esc).join(' · ')}</span>` : ''}</span>
    </button>
    ${pplRow ? `<button class="icon ppl" data-list="${list}" data-ppl="${i}" title="${t('Wer hat das gekauft?')}" aria-label="${t('Wer hat das gekauft?')}" aria-haspopup="dialog" aria-expanded="false">${PPL_ICON}</button>` : ''}
    <button class="icon" data-list="${list}" data-play="${i}" title="${t('Hier anhören')}" aria-label="${t('Hier anhören')}" aria-pressed="false">▶</button>
    <button class="icon heart ${on ? 'on' : ''}"${liking.has(e.tk) ? ' aria-disabled="true"' : ''} data-list="${list}" data-like="${i}" title="${t(on ? 'Von der Wishlist entfernen' : 'Auf die Wishlist setzen')}" aria-label="${t('Auf die Wishlist setzen')}" aria-pressed="${on}">${on ? '♥' : '♡'}</button>
    ${hide ? `<button class="icon x" data-list="${list}" data-hide="${i}" title="${t('Nicht mehr vorschlagen')}" aria-label="${t('Nicht mehr vorschlagen')}">✕</button>` : ''}
  </li>`;
}

// ---------- 0.9.55: Seltenheit, Nähe gefolgter Fans, Abwechslung, „Warum?“ ----------
// Seltenheit: wie viele aller gespeicherten Profile (Fans, Seelenverwandte, gefolgte Fans) einen Release haben.
// Was vor allem deine Leute haben, bleibt oben; Massen-Hits, die sowieso jeder hat, rutschen nach unten.
const RARE_POOL_MIN = 100;   // Anteil mindestens auf 100 Profile bezogen (wenige gespeicherte Profile: keine Ausreißer)
const RARE_SOFT = 2;         // rarity = 1 / log2(RARE_SOFT + Anteil in %): 0 % → 1, 2 % → 0,5, 10 % → 0,28
const RARE_HI = 0.7, RARE_LO = 0.35, NEAR_HI = 1.5;   // Schwellen für den „Warum?“-Text
const VAR_BLOCK = 10, VAR_MAX = 4;   // „Mehr Abwechslung“: höchstens 4 mit demselben Haupt-Tag je 10 Vorschläge
let popMemo = null, popBuilds = 0;
function popIndex() {
  const F = S.follow?.fans || null, m = popMemo;
  if (m && m.fans === fans && m.follow === F && m.ver === popVer && m.gen === dataGen) return m;   // nur neu zählen, wenn sich Profile ändern
  popBuilds++;
  const users = new Map(), cnt = new Map();
  for (const [u, f] of Object.entries(fans)) if (f?.keys?.length && !f.error) users.set(u, f.keys);
  for (const [u, f] of Object.entries(F || {})) {   // gefolgte Fans: wer auch als Fan-Profil gespeichert ist, zählt einmal
    const ks = (f.items || []).map((x) => x[0]), had = users.get(u);
    if (ks.length) users.set(u, had ? had.concat(ks) : ks);
  }
  for (const ks of users.values()) for (const k of new Set(ks)) cnt.set(k, (cnt.get(k) || 0) + 1);
  return (popMemo = { fans, follow: F, ver: popVer, gen: dataGen, cnt, size: users.size });
}
// ks: Release-Schlüssel des Vorschlags; voters: so viele Profile dieser Liste haben ihn beigesteuert
function rarityOf(ks, voters) {
  const { cnt, size } = popIndex();
  let pop = 0;
  for (const k of ks) pop = Math.max(pop, cnt.get(k) || 0);
  const others = Math.max(0, pop - voters);
  return 1 / Math.log2(RARE_SOFT + (others * 100) / Math.max(size, RARE_POOL_MIN));
}
const rareWhy = (r) => (r >= RARE_HI ? t('selten bei anderen Fans') : r < RARE_LO ? t('auch bei vielen anderen Fans') : '');
// Gefolgte Fans nach Geschmacksnähe: gemeinsame Releases mit dir, große Sammlungen zählen weniger; Median = 1
// 0.9.56: followMatch liefert dazu die Zahl gemeinsamer Releases (für den Regler „Mindestens gemeinsame Releases“)
let nearMemo = null;
function followNear(F) {
  if (nearMemo && nearMemo.F === F && nearMemo.my === mySet) return nearMemo;
  const w = {}, mm = {};
  for (const [u, f] of Object.entries(F)) {
    const items = f.items || [];
    let m = 0;
    for (const x of items) if (mySet.has(x[0])) m++;
    mm[u] = m;
    w[u] = (m + 0.5) / Math.log2(2 + items.length);
  }
  const v = Object.values(w).sort((a, b) => a - b), h = v.length >> 1;
  const med = v.length ? (v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2) : 1;
  for (const u in w) w[u] /= med || 1;
  return (nearMemo = { F, my: mySet, w, m: mm });
}
const followWeights = (F) => followNear(F).w;
const followMatch = (F) => followNear(F).m;
// Mehr Abwechslung: Blöcke à 10, ein Haupt-Tag (erster Tag des Releases) höchstens 4-mal je Block. Was nicht mehr passt,
// rückt (in seiner Reihenfolge) in den nächsten Block nach. Lieder ohne geladene Tags rücken nie nach hinten.
// Haupt-Tag: der erste, der keine Sammelbezeichnung ist („electronic“ hätten sonst fast alle, dann griffe die Grenze nicht)
const BROAD_TAGS = new Set(['electronic', 'electronica', 'electronic music', 'dance', 'edm', 'bass', 'bass music', 'club', 'experimental', 'alternative', 'underground', 'music', 'instrumental', 'beats']);
// 0.9.56: Ortsnamen („london“, „berlin“) sind kein Haupt-Tag: feste Liste häufiger Orte plus gelernt – Bandcamp hängt den Ort
// des Künstlers als letzten Tag an. Ein Tag, der bei mindestens 70 % seiner (≥ 5) Releases mit 3 oder mehr Tags ganz hinten
// steht, gilt als Ort (bei 1–2 Tags sagt die letzte Stelle nichts).
const LOC_TAGS = new Set(['london', 'uk', 'united kingdom', 'england', 'bristol', 'manchester', 'leeds', 'liverpool', 'birmingham', 'brighton',
  'sheffield', 'nottingham', 'newcastle', 'cardiff', 'wales', 'belfast', 'northern ireland', 'berlin', 'germany', 'deutschland', 'hamburg',
  'köln', 'koln', 'cologne', 'münchen', 'munchen', 'munich', 'leipzig', 'frankfurt', 'stuttgart', 'düsseldorf', 'dusseldorf', 'dresden',
  'paris', 'france', 'lyon', 'marseille', 'amsterdam', 'rotterdam', 'netherlands', 'holland', 'brussels', 'bruxelles', 'belgium', 'antwerp',
  'new york', 'new york city', 'nyc', 'brooklyn', 'los angeles', 'la', 'usa', 'us', 'united states', 'chicago', 'detroit', 'san francisco',
  'seattle', 'portland', 'philadelphia', 'boston', 'atlanta', 'miami', 'texas', 'austin', 'california', 'oakland', 'denver', 'new orleans',
  'toronto', 'montreal', 'vancouver', 'canada', 'melbourne', 'sydney', 'brisbane', 'perth', 'australia', 'auckland', 'wellington',
  'new zealand', 'tokyo', 'osaka', 'japan', 'moscow', 'st. petersburg', 'saint petersburg', 'russia', 'kyiv', 'kiev', 'ukraine', 'warsaw',
  'krakow', 'poland', 'prague', 'czech republic', 'czechia', 'vienna', 'wien', 'austria', 'zürich', 'zurich', 'geneva', 'basel', 'switzerland',
  'barcelona', 'madrid', 'valencia', 'spain', 'lisbon', 'lisboa', 'porto', 'portugal', 'milan', 'milano', 'rome', 'roma', 'turin', 'torino',
  'naples', 'bologna', 'italy', 'dublin', 'ireland', 'glasgow', 'edinburgh', 'scotland', 'copenhagen', 'denmark', 'stockholm', 'gothenburg',
  'sweden', 'oslo', 'norway', 'helsinki', 'finland', 'reykjavik', 'iceland', 'budapest', 'hungary', 'bucharest', 'romania', 'sofia',
  'bulgaria', 'athens', 'greece', 'istanbul', 'turkey', 'tbilisi', 'georgia', 'tel aviv', 'israel', 'brazil', 'brasil', 'são paulo',
  'sao paulo', 'rio de janeiro', 'mexico', 'mexico city', 'ciudad de méxico', 'buenos aires', 'argentina', 'santiago', 'chile', 'bogotá',
  'bogota', 'colombia', 'lima', 'peru', 'johannesburg', 'cape town', 'south africa', 'lagos', 'nigeria', 'nairobi', 'kenya', 'seoul',
  'korea', 'south korea', 'beijing', 'shanghai', 'china', 'hong kong', 'taipei', 'taiwan', 'singapore', 'bangkok', 'thailand', 'manila',
  'philippines', 'jakarta', 'indonesia', 'mumbai', 'delhi', 'new delhi', 'india', 'europe', 'scandinavia']);
let locMemo = null;
function learnedLocs() {
  if (locMemo && locMemo.tags === S.tags && locMemo.ver === tagVer) return locMemo.v;
  const carry = new Map(), last = new Map();
  for (const x of Object.values(S.tags)) {
    const ts = x?.t;
    if (!ts || ts.length < 3) continue;
    for (const g of ts) carry.set(g, (carry.get(g) || 0) + 1);
    const g = ts[ts.length - 1];
    last.set(g, (last.get(g) || 0) + 1);
  }
  const v = new Set();
  for (const [g, n] of last) if (n >= 5 && n >= 0.7 * carry.get(g)) v.add(g);
  locMemo = { tags: S.tags, ver: tagVer, v };
  return v;
}
const isLoc = (g, learned = learnedLocs()) => LOC_TAGS.has(g) || learned.has(g);
const mainTag = (e) => {
  const ts = tagsOf(e);
  if (!ts) return null;
  const loc = learnedLocs();
  return ts.find((x) => !BROAD_TAGS.has(x) && !isLoc(x, loc)) || ts.find((x) => !isLoc(x, loc)) || null;
};
function diversify(list, limit = 200) {
  if (S.settings.variety === false) return list;
  const out = [], q = [];
  let i = 0;
  while (out.length < limit && (i < list.length || q.length)) {
    const cnt = new Map(), block = [], later = [];
    const fits = (e) => { const g = mainTag(e); if (!g) return true; const c = cnt.get(g) || 0; if (c >= VAR_MAX) return false; cnt.set(g, c + 1); return true; };
    for (let j = 0; j < q.length && block.length < VAR_BLOCK;) if (fits(q[j])) block.push(q.splice(j, 1)[0]); else j++;
    while (block.length < VAR_BLOCK && i < list.length) { const e = list[i++]; if (fits(e)) block.push(e); else { e.dfr = true; later.push(e); } }
    q.push(...later);
    while (block.length < VAR_BLOCK && i >= list.length && q.length) block.push(q.shift());   // nichts anderes mehr übrig
    out.push(...block);
  }
  return out.concat(q, list.slice(i));
}

// ---------- 0.9.56: Geschmack lernen ----------
// Signale: ♥ (positiv), Ausblenden und Überspringen (negativ), dazu deine eigenen Käufe/Wishlist (halb positiv). Daraus ein
// Gewicht je Tag (Sammel-Tags und Orte zählen nicht) und ein Vertrauen je Fan (wessen Tipps du ♥st bzw. ausblendest).
const TASTE_MAX = 8000, TASTE_BY = 20;
const TASTE_LO = 0.4, TASTE_HI = 2.5, TRUST_LO = 0.5, TRUST_HI = 2;
const TASTE_WHY_HI = 1.2, TASTE_WHY_LO = 0.8, TRUST_WHY = 1.3;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
let tasteVer = 0, tasteMemo = null;
const saveTaste = () => store.set({ taste: { ev: S.taste, w: WIN } });
// Lieder in den Listen tragen byU (Benutzernamen der Fans, die sie vorschlagen); aus Verlauf/Fenstern dort nachschlagen
const byOf = (e) => e.byU || [tipsCache, scoutCache, promoCache].map((c) => c.find((x) => x.tk === e.tk)?.byU).find(Boolean) || [];
// 0.9.60: mit Künstler (a) für „Bekannte Künstler bevorzugen“; addTastes: viele auf einmal (ein Speichern)
function addTastes(list, k) {
  list = list.filter((e) => e?.tk);
  if (!list.length) return;
  const tks = new Set(list.map((e) => e.tk)), at = Date.now();
  if (k !== 'skip') S.taste = S.taste.filter((x) => !(tks.has(x.tk) && x.k === k));   // je Lied ein ♥ bzw. ein Ausblenden
  for (const e of list) S.taste.push({ tk: e.tk, url: e.url || null, k, at, by: byOf(e).slice(0, TASTE_BY), ...(e.artist ? { a: e.artist } : {}) });
  if (S.taste.length > TASTE_MAX) S.taste = S.taste.slice(-TASTE_MAX);   // die neuesten 2000
  tasteVer++;
  saveTaste();
  const urls = list.filter((e) => e.url).map((e) => ({ url: e.url }));
  if (urls.length) needTags(urls, urls.length);
}
const addTaste = (e, k) => addTastes([e], k);
function removeTaste(tks, k) {
  const set = new Set(tks), n = S.taste.length;
  S.taste = S.taste.filter((x) => !(x.k === k && set.has(x.tk)));
  if (S.taste.length !== n) { tasteVer++; saveTaste(); }
}
// Tags eines Releases, die etwas über den Geschmack sagen (ohne Sammel-Tags und Orte)
function tasteTags(url, loc = learnedLocs()) {
  const ts = url ? S.tags[tagKey(url)]?.t : null;
  return ts ? ts.filter((g) => !BROAD_TAGS.has(g) && !isLoc(g, loc)) : [];
}
function tasteModel() {
  const m = tasteMemo, me = S.me, mn = me?.keys?.length || 0;
  if (m && m.ev === S.taste && m.ver === tasteVer && m.tags === S.tags && m.tv === tagVer && m.me === me && m.mn === mn) return m;
  const loc = learnedLocs(), pos = new Map(), neg = new Map(), fp = new Map(), fn = new Map();
  const add = (mp, x, v) => mp.set(x, (mp.get(x) || 0) + v);
  for (const ev of S.taste) {
    const good = ev.k === 'like';
    for (const g of tasteTags(ev.url, loc)) add(good ? pos : neg, g, 1);
    for (const u of ev.by || []) add(good ? fp : fn, u, 1);
  }
  // eigene Sammlung zählt bewusst nicht: sie würde genau die Blase verstärken, aus der die Vorschläge herausführen sollen (0.9.56)
  const w = new Map();
  // Wie viel häufiger steht ein Tag bei ♥ als bei ✕/Überspringen – jeweils im Verhältnis zur Zahl der Ereignisse. Ein Tag,
  // der überall dabei ist (z. B. „dubstep“ bei Gemochtem wie Übersprungenem), bleibt so bei 1; „riddim“ nur bei
  // Übersprungenem sinkt. Wenige Ereignisse wirken schwächer (Exponent n / (n + 3)). Tags ohne Signal sind 1.
  let P = 0, N = 0;
  for (const ev of S.taste) if (ev.k === 'like') P++; else N++;
  for (const g of new Set([...pos.keys(), ...neg.keys()])) {
    const p = pos.get(g) || 0, q = neg.get(g) || 0, ratio = ((p + 1) / (P + 2)) / ((q + 1) / (N + 2));
    w.set(g, clamp(ratio ** ((p + q) / (p + q + 3)), TASTE_LO, TASTE_HI));
  }
  const trust = new Map();
  for (const u of new Set([...fp.keys(), ...fn.keys()])) trust.set(u, clamp(((fp.get(u) || 0) + 1) / ((fn.get(u) || 0) + 1), TRUST_LO, TRUST_HI));
  return (tasteMemo = { ev: S.taste, ver: tasteVer, tags: S.tags, tv: tagVer, me, mn, w, trust, loc, fx: new Map() });
}
// Geschmacksfaktor eines Lieds: geometrisches Mittel der Tag-Gewichte (1 ohne bekannte Tags)
function tasteOf(url) {
  const m = tasteModel(), key = tagKey(url || '');
  if (m.fx.has(key)) return m.fx.get(key);
  const ts = tasteTags(url, m.loc);
  let l = 0;
  for (const g of ts) l += Math.log(m.w.get(g) ?? 1);
  const v = ts.length ? Math.exp(l / ts.length) : 1;
  m.fx.set(key, v);
  return v;
}
const trustOf = (u) => tasteModel().trust.get(u) ?? 1;
const meanTrust = (us) => (us.length ? us.reduce((a, u) => a + trustOf(u), 0) / us.length : 1);
// „Neuere bevorzugen“: Kauf der letzten 12 Monate ×1,5, älter als 3 Jahre ×0,7 (d = Kaufdatum in Sekunden)
const YEAR = 365 * DAY;
const recency = (d, now) => (!S.settings.preferNew || !d ? 1 : now - d <= YEAR ? 1.5 : now - d > 3 * YEAR ? 0.7 : 1);
// Warum-Zusätze für Geschmack, Fan-Vertrauen und neue Käufe
function tasteWhy(e, now) {
  return [e.taste >= TASTE_WHY_HI ? t('passt zu deinen Tags') : e.taste <= TASTE_WHY_LO ? t('Tags, die du oft überspringst oder ausblendest') : '',
    meanTrust(e.byU) >= TRUST_WHY ? t('von Fans, deren Tipps dir oft gefallen') : '',
    S.settings.preferNew && e.newest && now - e.newest <= YEAR ? t('neuer Kauf') : ''];
}
// ---------- 0.9.60: Bekannte Künstler bevorzugen ----------
// Künstler (normalisierter Bandname) aus deiner Sammlung/Wishlist und mit ♥ heben einen Vorschlag: 1 → ×1,3, 2 → ×1,55, ab 3 → ×1,8.
// Je Ausblenden/Überspringen dieses Künstlers ×0,9 (bis 0,6). Zusammen 0,6 … 1,8. Ereignisse ohne Künstler (vor 0.9.60) zählen nicht.
const ART_F = [1, 1.3, 1.55, 1.8], ART_LO = 0.6, ART_HI = 1.8, ART_WHY_LO = 0.85;
let artMemo = null;
function artistModel() {
  const me = S.me, mn = me?.keys?.length || 0, m = artMemo;
  if (m && m.me === me && m.mn === mn && m.ev === S.taste && m.ver === tasteVer) return m;
  const pos = new Map(), neg = new Map();
  const add = (mp, a) => { const k = norm(a); if (k) mp.set(k, (mp.get(k) || 0) + 1); };
  for (const it of Object.values(me?.items || {})) add(pos, it?.[1]);
  for (const ev of S.taste) if (ev.a) add(ev.k === 'like' ? pos : neg, ev.a);
  return (artMemo = { me, mn, ev: S.taste, ver: tasteVer, pos, neg, fx: new Map() });
}
// { c: positive Zählung, f: Faktor } – f = 1, wenn die Einstellung aus ist
function artistOf(name) {
  if (S.settings.knownArtists === false) return { c: 0, f: 1 };
  const m = artistModel(), k = norm(name);
  let v = m.fx.get(k);
  if (v) return v;
  const c = m.pos.get(k) || 0, q = m.neg.get(k) || 0;
  v = { c, f: clamp(ART_F[Math.min(3, c)] * Math.max(ART_LO, 0.9 ** q), ART_LO, ART_HI) };
  m.fx.set(k, v);
  return v;
}
const artistWhy = (kn) => (!kn ? [] : [kn.c >= 1 ? t('Künstler aus deiner Sammlung ({n}×)', { n: kn.c }) : '', kn.f < ART_WHY_LO ? t('Künstler, den du oft überspringst') : '']);

// Tags für den Geschmack im Hintergrund nachladen: alles mit ♥, ausgeblendet oder
// übersprungen. Kosten: höchstens 1 Anfrage pro Release und alle 60 Tage, nur mit Marken, die sonst überlaufen würden (needTags).
function tasteTagsLoad() {
  if (!S.me) return;
  const urls = [...S.taste.map((x) => x.url), ...Object.values(S.hidden).map((v) => v?.u)].filter(Boolean);
  needTags([...new Set(urls)].map((url) => ({ url })), Infinity);
}

// ---------- 0.9.59: Listen bleiben stehen ----------
// Einmal gezeigt, behält eine Trackliste ihre Reihenfolge, solange du in ihr bleibst: ♥, ✕, Geschmacks-Signale, nachgeladene Tags,
// Hintergrund-Suchen sortieren nicht um. Was wegfällt, verschwindet an seinem Platz; Neues kommt hinten dran (außer die Liste war leer).
// Neu sortiert wird beim Wechsel von Reiter oder Ansicht, mit dem Knopf oben, über „Neu sortieren“, bei Tag-Filter und Einstellungen
// und wenn links ein anderer Release offen ist (ctx).
const LIST_MAX = 200, RESORT_CMP = 50;
const frozen = { tips: null, scouts: null, promos: null };   // { ctx, tks: Reihenfolge, seen: schon einmal berechnet }
function unfreeze(...lists) { for (const l of lists.length ? lists : TAG_LISTS) frozen[l] = null; }
// pool: alle passenden Einträge (nach Tag-Filter, mit gehörten), sortiert; arrange: z. B. diversify;
// grp: Rang der Gruppe (Promos) – Neues kommt dann ans Ende seiner Gruppe statt ans Ende der Liste
// note (0.9.60): kurze Zusatzinfo in der Zeile über der Liste (z. B. wie viele Seelenverwandte abstimmen)
function stableList(list, ctx, pool, arrange = (x) => x, grp = null, note = '') {
  // 0.9.60: das Lied im Player (läuft oder pausiert) bleibt immer stehen
  const vis = S.settings.hideHeard ? pool.filter((e) => !isHeard(e.tk) || e.tk === playing?.tk) : pool;
  const order = arrange(vis);
  let f = frozen[list], out;
  if (!f || f.ctx !== ctx || !f.tks.some((tk) => f.on.has(tk))) {
    out = order.slice(0, LIST_MAX);
    f = frozen[list] = { ctx, tks: out.map((e) => e.tk), seen: new Set(pool.map((e) => e.tk)), g: new Map() };
    if (grp) for (const e of out) f.g.set(e.tk, grp(e));
  } else {
    const by = new Map(pool.map((e) => [e.tk, e]));
    out = f.tks.map((tk) => by.get(tk)).filter(Boolean);   // weggefallene bleiben in tks: kommen sie zurück, dann an ihrem Platz
    const add = order.filter((e) => !f.seen.has(e.tk)).slice(0, Math.max(0, LIST_MAX - out.length));
    for (const e of pool) f.seen.add(e.tk);
    for (const e of add) { f.tks.push(e.tk); out.push(e); }
    if (grp) {
      // stabil: innerhalb der Gruppe bleibt alles, wie es war; 0.9.65: Weggefallene behalten ihre Gruppe (f.g) und damit ihren Platz
      for (const e of out) f.g.set(e.tk, grp(e));
      f.tks.sort((a, b) => (f.g.get(a) ?? 9) - (f.g.get(b) ?? 9));
      out = f.tks.map((tk) => by.get(tk)).filter(Boolean);
    }
  }
  f.on = new Set(out.map((e) => e.tk));
  const top = (a) => a.slice(0, RESORT_CMP).map((e) => e.tk).join();
  sortBar(list, top(order) !== top(out), pool.length - vis.length, note);
  return out;
}
// Zeile über der Liste: Haken „Gehörte ausblenden“, „{n} gehörte ausgeblendet“, „Neu sortieren“ (nur wenn sich etwas geändert hat)
function sortBar(list, diff, nHid, note = '') {
  const row = $(`.sortrow[data-list="${list}"]`);
  if (!row) return;
  row.querySelector('input').checked = !!S.settings.hideHeard;
  const info = row.querySelector('.hhinfo');
  info.textContent = info.title = [note, S.settings.hideHeard && nHid ? t('{n} gehörte ausgeblendet', { n: nHid }) : ''].filter(Boolean).join(' · ');
  // 0.9.66: warum Tracks fehlen – Klick öffnet die Genre-Filter in den Einstellungen
  if (tagFilterOn()) {
    const b = document.createElement('button');
    b.className = 'gfhint'; b.textContent = t('Genre-Filter aktiv'); b.title = genreTitle() + ' – ' + t('In den Einstellungen ändern');
    if (info.textContent) info.append(' · ');
    info.append(b);
  }
  ctlSync(list);
  showResort(list, diff);
  updateBulk();
}
// 0.9.66: Regler direkt über der Liste (Gefolgt; Für Dich · Tracks – bei Aktueller Track · Tracks ausgeblendet)
function ctlSync(list) {
  const row = $(`.ctlrow[data-list="${list}"]`);
  if (!row) return;
  if (list === 'tips') row.classList.toggle('hidden', !soulOn);
  for (const sel of row.querySelectorAll('select')) {
    const v = String(sel.dataset.set === 'soulRefresh' ? soulRefreshN() : S.settings[sel.dataset.set]);
    if (sel.value !== v) sel.value = v;
  }
  const sr = row.querySelector('[data-set="soulRefresh"]')?.closest('label');
  if (sr) sr.title = t('So viele deiner besten Seelenverwandten werden für ‚Tracks‘ frisch geladen (je etwa {c} Anfragen).', { c: Math.round(deepCost()) });
}
function showResort(list, on) { $(`.sortrow[data-list="${list}"] .resort`)?.classList.toggle('hidden', !on); }
// ---------- 0.9.60: „Alle gehörten ausblenden“ ----------
// Gehörte (S.heard), noch nicht ausgeblendet, ohne ♥ und nicht das Lied im Player
const heardToHide = () => Object.keys(S.heard).filter((tk) => !S.hidden[tk] && !S.liked[tk] && tk !== playing?.tk);
function updateBulk() {
  const n = heardToHide().length;
  document.querySelectorAll('.sortrow .bulkhide').forEach((b) => { b.classList.toggle('hidden', !n); b.disabled = !n; });
  if (!n) document.querySelectorAll('.sortrow .bulkask').forEach((x) => x.classList.add('hidden'));
}
// wie ✕ auf jeder Zeile: in S.hidden (packSong) und je ein Ausblend-Signal mit den Fans (by) und dem Künstler – über alle Listen
function hideAllHeard() {
  const tks = heardToHide();
  if (!tks.length) return 0;
  const need = new Set(tks), found = new Map();
  for (const c of [tipsCache, scoutCache, promoCache]) for (const e of c) if (need.has(e.tk) && !found.has(e.tk)) found.set(e.tk, e);
  for (const h of S.history) if (need.has(h.tk) && !found.has(h.tk)) found.set(h.tk, unpackSong(h.tk, h));
  // nicht in den Listen: Lied und vorschlagende Fans aus den gespeicherten Profilen
  if (tks.some((tk) => !found.get(tk)?.byU)) {
    const by = new Map(), look = (u, k, m) => {
      const e = trackOf(k, m);
      if (!need.has(e.tk)) return;
      if (!found.has(e.tk)) found.set(e.tk, e);
      const l = by.get(e.tk) || []; if (!l.includes(u)) l.push(u); by.set(e.tk, l);
    };
    for (const [u, f] of Object.entries(fans)) if (!f.error) for (const [k, m] of Object.entries(f.meta || {})) look(u, k, m);
    for (const [u, f] of Object.entries(S.follow?.fans || {})) for (const [k, m] of f.items || []) look(u, k, m);
    for (const [tk, e] of found) if (!e.byU && by.has(tk)) found.set(tk, { ...e, byU: by.get(tk) });
  }
  const list = tks.map((tk) => found.get(tk) || { tk, title: '', album: '', artist: '', url: null, art: null, trackId: tk[0] === 't' ? tk.slice(1) : null, albumId: null });
  for (const e of list) S.hidden[e.tk] = packSong(e);
  store.set({ hidden: S.hidden });
  addTastes(list, 'hide');
  renderTips(); renderScouts(); renderPromos();   // Zeilen verschwinden an ihrem Platz (Listen bleiben stehen)
  updateBulk();
  toast(t('{n} Tracks ausgeblendet', { n: list.length }));
  return list.length;
}
// Liste neu füllen, ohne dass sie nach oben springt
function fillList(el, html) {
  const top = el.scrollTop;
  el.innerHTML = html;
  if (el.scrollTop !== top) el.scrollTop = top;
}

let tipsCache = [];
function renderTips() {
  // 0.9.68: leere Liste sagt den nächsten Schritt – ohne offenen Release nicht „Suche starten“ (der Knopf ist dann gesperrt)
  const none = !S.me ? NEED_ME : soulOn ? '' : !cur && !pending ? 'Öffne links ein Album oder einen Track auf Bandcamp' : !tipsOn || !cur ? 'Drück oben auf „Suche starten“.' : '';
  if (none) { tipsCache = []; unfreeze('tips'); sortBar('tips', false, 0); $('#tipsList').innerHTML = `<li class="empty">${t(none)}</li>`; return; }
  computeAll();
  const r = new Map();
  // nur die Fans des gerade offenen Releases (Schnittmenge mit deiner Wishlist), nicht alle jemals geprüften –
  // bzw. bei „Seelenverwandte“ die besten 300 von ihnen mit frischer Kaufliste (0.9.60, vorher 50)
  const twins = soulOn ? soulList().slice(0, TWIN_KEEP_N).map((x) => x.f).filter((f) => f.meta && fanFresh(f.u))
    : cur.fans.map((u) => fans[u]).filter((f) => f?.meta && f.m >= S.settings.minMatch && f.total >= S.settings.minTotal);
  const now = Date.now() / 1000;
  for (const f of twins) {
    const tr = trustOf(f.u);   // 0.9.56: Fans, deren Tipps du ♥st, zählen mehr; ausgeblendete/übersprungene weniger
    for (const [k, meta] of Object.entries(f.meta)) {
      const t = trackOf(k, meta);
      if ((isMine(k, meta, t) && !S.liked[t.tk]) || S.hidden[t.tk]) continue;
      const e = r.get(t.tk) || { ...t, s: 0, by: [], byU: [], fav: 0, ks: new Set(), newest: 0 };
      e.s += f.sc * (t.custom ? 1.5 : 1) * tr * recency(t.date, now);
      e.ks.add(k);   // Seltenheit zählt pro Release, nicht pro Track
      if (t.custom) e.fav++;
      e.by.push(f.name || f.u);
      e.byU.push(f.u);   // Benutzernamen für die Geschmacks-Signale
      e.newest = Math.max(e.newest, t.date || 0);
      if (!e.title && t.title) Object.assign(e, { title: t.title, trackId: t.trackId });
      if (!e.art && t.art) e.art = t.art;
      r.set(t.tk, e);
    }
  }
  // 0.9.60: „Für Dich · Tracks“ nur ab minFans Stimmen, „Aktueller Track“ wie bisher; 0.9.66: eigener Regler über der Liste (minFansTips)
  const minF = S.settings.minFansTips, raw = r.size;
  const all = [...r.values()].filter(soulOn ? (e) => e.by.length >= minF : (e) => e.by.length >= 2 || twins.length < 5);
  for (const e of all) { e.rar = rarityOf(e.ks, e.by.length); e.taste = tasteOf(e.url); e.kn = artistOf(e.artist); e.s *= e.rar * e.taste * e.kn.f; }
  all.sort((a, b) => b.s - a.s);
  tipsCache = stableList('tips', soulOn ? 'soul' : 'match|' + cur.url, applyTagFilter('tips', all), diversify, null,
    soulOn && twins.length ? t('{n} Seelenverwandte stimmen ab', { n: twins.length }) : '');
  for (const e of tipsCache) e.why = [rareWhy(e.rar), t(soulOn ? 'bei {n} Seelenverwandten' : 'bei {n} Fans', { n: e.by.length }), ...tasteWhy(e, now), ...artistWhy(e.kn),
    e.dfr ? t('für mehr Abwechslung nach hinten gerückt') : ''].filter(Boolean).join(' · ');
  fillList($('#tipsList'), tipsCache.map((e, i) => trackItem(e, i, 'tips', t('bei {n} Fans', { n: e.by.length }))).join('')
    || `<li class="empty">${t(all.length ? 'Kein Tipp mit diesen Tags (bisher).' : soulOn && raw ? 'Noch keine Tracks bei mindestens {n} Fans. Stell den Regler über der Liste niedriger oder lass die Suche weiterlaufen.'
      : (soulOn ? soulRunning : cur.scanning) ? 'Suche läuft …'
      : soulOn ? (twins.length ? 'Noch keine Trackvorschläge von deinen Seelenverwandten.' : soulTop().length ? 'Die Kauflisten deiner besten 300 Seelenverwandten bleiben dauerhaft gespeichert, die übrigen 6 Stunden. Oben auf „Tracks laden“, sobald der Knopf frei ist.' : 'Drück oben auf „Seelenverwandte suchen“.') : 'Noch keine Trackvorschläge für diesen Release.', { n: minF })}</li>`);
  markPlaying();
}

let scoutCache = [];
function renderScouts(F = S.follow, progress = '') {
  const max = S.settings.scoutItems;
  const fol = F?.fans ? Object.keys(F.fans).filter((u) => !unfollowed(u)) : [], n = fol.length;   // 0.9.65: entfolgte zählen sofort nicht mehr
  // 0.9.68: ohne Sammlung bzw. ohne gefolgte Fans sagen, was zu tun ist (statt „0 von 0 gefolgten Fans“)
  if (!F?.fans || !S.me || (!n && !progress)) {
    scoutCache = []; unfreeze('scouts'); sortBar('scouts', false, 0);
    $('#scoutInfo').textContent = !S.me || !F?.fans ? t('Noch nicht abgerufen.') : t('Du folgst auf Bandcamp noch keinen Fans.');
    $('#scoutList').innerHTML = `<li class="empty">${t(!S.me ? NEED_ME : !F?.fans ? 'Drück oben auf „Suche starten“, um die Käufe der Fans zu lesen, denen du folgst.'
      : 'Folge auf Bandcamp ein paar Fans – zum Beispiel aus „Aktueller Track“ oder „Für Dich“ – und drück dann oben auf „Suche starten“.')}</li>`;
    pplSync('scouts'); return;
  }
  const r = new Map(), wf = followWeights(F.fans), fm = followMatch(F.fans), now = Date.now() / 1000;
  // 0.9.56: Regler „Mindestens gemeinsame Releases“ – ab 5 zählen nur gefolgte Fans, die so viele Releases mit dir teilen
  // (bei 2, der Vorgabe, wie bisher alle)
  const minM = S.settings.minMatch, strict = minM > MATCH_MIN;
  const use = fol.filter((u) => !strict || fm[u] >= minM);
  for (const u of use) {
    const f = F.fans[u], tr = trustOf(u);
    for (const [k, meta] of (f.items || []).slice(0, max)) {         // neueste zuerst gespeichert
      const t = trackOf(k, meta);
      if ((isMine(k, meta, t) && !S.liked[t.tk]) || S.hidden[t.tk]) continue;
      // gezählt wird pro Release, damit unterschiedliche Lieblingstracks eines Albums zusammen zählen
      const e = r.get(k) || { ...t, k, n: 0, w: 0, near: 0, newest: 0, byU: [] };
      e.n++;
      e.w += wf[u] * tr * recency(t.date, now);   // Summe der Geschmacksnähe statt bloßer Anzahl (× Vertrauen, × neuer Kauf)
      e.byU.push(u);
      if (wf[u] >= NEAR_HI) e.near++;
      e.newest = Math.max(e.newest, t.date || 0);
      if (t.custom && !e.custom) Object.assign(e, { tk: t.tk, trackId: t.trackId, title: t.title, custom: true });
      r.set(k, e);
    }
  }
  // 0.9.60: Regler „Mindestens Fans pro Track“ gilt auch hier (vorher fest 2); 0.9.66: eigener Wert (minFansScouts)
  const minF = S.settings.minFansScouts, over = [...r.values()].some((e) => e.n >= 2);
  const all = [...r.values()].filter((e) => e.n >= minF);
  for (const e of all) { e.rar = rarityOf([e.k], e.n); e.taste = tasteOf(e.url); e.kn = artistOf(e.artist); e.s = e.w * e.rar * e.taste * e.kn.f; }
  all.sort((a, b) => (b.s - a.s) || (b.n - a.n) || (b.newest - a.newest));
  scoutCache = stableList('scouts', 'scouts', applyTagFilter('scouts', all), diversify);
  for (const e of scoutCache) e.why = [rareWhy(e.rar), e.near ? t('bei {n} gefolgten Fans, {m} davon mit viel Gemeinsamkeit', { n: e.n, m: e.near })
    : t('bei {n} gefolgten Fans', { n: e.n }), ...tasteWhy(e, now), ...artistWhy(e.kn), e.dfr ? t('für mehr Abwechslung nach hinten gerückt') : ''].filter(Boolean).join(' · ');
  const date = new Date(F.at).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
  $('#scoutInfo').textContent = progress
    || (strict ? t('{q} von {n} gefolgten Fans passen · Stand {date}', { q: use.length, n, date })
      : F.total != null ? t('{a} von {b} gefolgten Fans gelesen · Stand {date}', { a: F.count ?? n, b: Math.max(F.total, F.count ?? n), date })   // 0.9.60
      : t('{n} gefolgte Fans · Stand {date}', { n, date }));
  const few = strict && use.length < 2 ? t('Nur {n} deiner gefolgten Fans teilen mindestens {m} Releases mit dir. Stell den Regler über der Liste niedriger.', { n: use.length, m: minM }) : '';
  fillList($('#scoutList'), scoutCache.map((e, i) => trackItem(e, i, 'scouts', t('bei {a} von {b} Fans', { a: e.n, b: n }))).join('')
    || `<li class="empty">${few || t(all.length ? 'Kein Lied mit diesen Tags (bisher).' : over ? 'Noch keine Tracks bei mindestens {n} deiner gefolgten Fans. Folge weiteren passenden Fans oder stell den Regler über der Liste niedriger.'
      : 'Noch keine Überschneidungen zwischen deinen gefolgten Fans.', { n: minF })}</li>`);
  markPlaying();
  pplSync('scouts');
}

// ---------- 0.9.58: Promos – Pre-Orders und ganz neue Releases deiner Leute ----------
// Quelle sind nur Käufe (keine Wishlists): gefolgte Fans (S.follow) und die frischen Profile deiner besten 20 Seelenverwandten,
// gekauft in den letzten 30 Tagen. Ob ein Release Pre-Order bzw. ganz neu ist, steht auf seiner Seite – die lädt der Tag-Worker
// ohnehin (relInfo, keine Zusatzanfrage), mit Marken, die sonst überlaufen würden; je Aktualisierung höchstens 150.
const PROMO_BUY_DAYS = 30, PROMO_NEW_DAYS = 14, PROMO_TWINS = 20, PROMO_CHECK = 150, PROMO_TWIN_W = 1.5, PROMO_WHY = 5;
const promoTried = new Set();   // alte Tag-Einträge ohne Release-Datum: je Sitzung nur einmal neu laden
let promoCache = [];
// Kandidaten je Release: Käufer (Benutzernamen und Namen), Gewicht, neuester Kauf – neueste Käufe zuerst
function promoCands() {
  const now = Date.now() / 1000, from = now - PROMO_BUY_DAYS * DAY, r = new Map();
  const F = S.follow?.fans || {}, wf = S.follow?.fans ? followWeights(F) : {};
  const add = (u, name, k, meta, w) => {
    const d = meta?.[6] || 0;
    if (d < from) return;
    const t = trackOf(k, meta);
    if ((isMine(k, meta, t) && !S.liked[t.tk]) || S.hidden[t.tk]) return;
    const e = r.get(k) || { ...t, k, byU: [], by: [], w: 0, newest: 0, pre: 0 };
    if (e.byU.includes(u)) return;   // gefolgt und Seelenverwandter: einmal
    e.byU.push(u); e.by.push(name || u);
    e.w += w * trustOf(u);
    e.newest = Math.max(e.newest, d);
    if (meta[9] === 1) e.pre = 1;   // Kauf als Pre-Order gemeldet
    if (t.custom && !e.custom) Object.assign(e, { tk: t.tk, trackId: t.trackId, title: t.title, custom: true });
    r.set(k, e);
  };
  for (const [u, f] of Object.entries(F)) if (!unfollowed(u)) for (const [k, meta] of f.items || []) add(u, f.name, k, meta, wf[u] ?? 1);
  for (const tw of soulTop().slice(0, PROMO_TWINS)) {
    const f = fans[tw.u];
    if (!f?.meta || f.error || !fanFresh(tw.u) || unfollowed(tw.u)) continue;   // 0.9.65: entfolgt heißt: seine Käufe nicht mehr zeigen
    for (const [k, meta] of Object.entries(f.meta)) add(tw.u, (tw.name && tw.name !== tw.u ? tw.name : f.name) || tw.u, k, meta, PROMO_TWIN_W);
  }
  return [...r.values()].sort((a, b) => b.newest - a.newest);
}
// 'pre' (Pre-Order bzw. Datum in der Zukunft), 'new' (seit höchstens 14 Tagen erschienen), 'old' oder null (Seite noch nicht geladen)
function promoStatus(e, now = Date.now()) {
  const x = S.tags[tagKey(e.url || '')], known = !!x && 'pre' in x, rd = known ? x.rd || 0 : 0;
  e.rd = rd;
  if (rd) return rd > now ? 'pre' : now - rd <= PROMO_NEW_DAYS * 864e5 ? 'new' : 'old';
  if (known ? x.pre : e.pre) return 'pre';
  return known ? 'old' : null;
}
// Release-Seiten der neuesten 150 Kandidaten anstellen; Einträge älterer Versionen (ohne Datum) einmal neu
function queuePromos(list) {
  for (const e of list) {
    const k = tagKey(e.url || ''), x = S.tags[k];
    if (!k || !x || 'pre' in x || x.err || promoTried.has(k) || tagQueued.has(k)) continue;
    promoTried.add(k); tagQueued.add(k); tagQueue.push(k);
  }
  needTags(list, PROMO_CHECK);
}
// „Promos aktualisieren“: nur Release-Seiten – Pre-Orders und noch Unbekanntes, die länger als einen Tag nicht geprüft wurden
function refreshPromos() {
  const now = Date.now();
  for (const e of promoCands().slice(0, PROMO_CHECK)) {
    const k = tagKey(e.url || ''), x = S.tags[k];
    if (!k || tagQueued.has(k) || (x && now - x.at < 864e5) || (x && 'pre' in x && promoStatus(e, now) !== 'pre')) continue;
    tagQueued.add(k); tagQueue.push(k);
  }
  promoTried.clear();
  if (!tagWorkerOn && tagQueue.length) tagWorker();
  renderPromos();
}
// Knopf im Reiter: ohne frische Käufe der gefolgten Fans (älter als 24 h) deren Suche, sonst nur die Release-Seiten
function promoAction() {
  if (!S.me) return { label: t('Suche starten'), title: t(NEED_ME) };
  if (!S.follow?.fans || Date.now() - (S.follow.at || 0) > 864e5) return scoutsGate();
  return { label: t('Promos aktualisieren'), title: t('Prüft Pre-Orders und noch unbekannte Releases nochmal – nur die Release-Seiten, keine Fan-Profile.'), run: refreshPromos };
}
function renderPromos() {
  if (realTab !== 'promos') return;   // nur der sichtbare Reiter lädt Release-Seiten nach
  const el = $('#promoList'), info = $('#promoInfo'), intro = t('Pre-Orders und ganz neue Releases, die deine gefolgten Fans und Seelenverwandten gekauft haben.');
  if (!S.me) { promoCache = []; unfreeze('promos'); sortBar('promos', false, 0); info.textContent = intro; el.innerHTML = `<li class="empty">${t(NEED_ME)}</li>`; pplSync('promos'); return; }
  const now = Date.now(), cands = promoCands();
  queuePromos(cands.slice(0, PROMO_CHECK));
  const all = [];
  let open = 0;
  for (const e of cands) {
    const st = promoStatus(e, now);
    if (st === null) { if (tagQueued.has(tagKey(e.url || ''))) open++; continue; }
    if (st === 'old') continue;
    e.grp = st;
    e.taste = tasteOf(e.url);
    e.kn = artistOf(e.artist);
    e.s = e.w * e.taste * e.kn.f;
    all.push(e);
  }
  // Pre-Orders zuerst, darin nach gewichteten Käufern (Nähe × Vertrauen × Geschmack), dann neuester Kauf
  all.sort((a, b) => ((a.grp === 'pre' ? 0 : 1) - (b.grp === 'pre' ? 0 : 1)) || (b.s - a.s) || (b.newest - a.newest));
  promoCache = stableList('promos', 'promos', applyTagFilter('promos', all), undefined, (e) => (e.grp === 'pre' ? 0 : 1));
  const day = (ms) => new Date(ms).toLocaleDateString(locale(), { dateStyle: 'short' });
  for (const e of promoCache) e.why = [e.by.slice(0, PROMO_WHY).join(', ') + (e.by.length > PROMO_WHY ? ' …' : ''), ...artistWhy(e.kn)].filter(Boolean).join(' · ');
  info.textContent = open ? t(open === 1 ? 'Prüfe 1 Release …' : 'Prüfe {n} Releases …', { n: open }) : scoutsRunning ? t('Lese die Fans, denen du folgst …') : intro;
  let grp = '';
  fillList(el, promoCache.map((e, i) => {
    const head = e.grp !== grp ? `<li class="listhead grouphead"><span>${t(e.grp === 'pre' ? 'Vorab (Pre-Order)' : 'Neu erschienen (14 Tage)')}</span></li>` : '';
    grp = e.grp;
    // 0.9.66: Datum/Status und „bei N deiner Leute“ getrennt, je eine Zeile (vorher ein Text, der zufällig umbrach)
    const st = e.grp === 'pre' ? (e.rd ? t('erscheint am {date}', { date: day(e.rd) }) : t('Pre-Order')) : t('erschienen am {date}', { date: day(e.rd) });   // 0.9.66: „Pre-Order“ steht schon in der Gruppenüberschrift
    return head + trackItem(e, i, 'promos', { st, cnt: t('bei {n} deiner Leute', { n: e.byU.length }) });
  }).join('')
    || `<li class="empty">${t(all.length ? 'Kein Lied mit diesen Tags (bisher).' : open ? (open === 1 ? 'Prüfe 1 Release …' : 'Prüfe {n} Releases …') : !S.follow?.fans ? 'Lies zuerst oben die Käufe deiner gefolgten Fans.'
      : !cands.length && !Object.keys(S.follow.fans).some((u) => !unfollowed(u)) && !soulTop().length   // 0.9.68: noch niemand, dessen Käufe hier landen könnten
        ? 'Hier erscheinen Pre-Orders und neue Releases, sobald du auf Bandcamp Fans folgst oder unter „Für Dich“ Seelenverwandte gefunden hast.'
      : 'Gerade keine Pre-Orders oder ganz neuen Releases bei deinen Leuten.', { n: open })}</li>`);
  markPlaying();
  pplSync('promos');
}

// Sprache und Darstellung (hell/dunkel) – ohne gespeicherte Wahl gilt die Browsersprache bzw. das System
function applyLook() {
  const nav = (navigator.language || 'de').slice(0, 2);
  LANG = S.settings.lang || (LANGS[nav] ? nav : 'de');
  document.documentElement.dataset.theme = S.settings.theme || 'system';
  applyI18n();
  fitTabs(true);
}
// Reiter so groß wie möglich (10 bis 13,5 px), ohne dass ein Name abgeschnitten wird: gemessen mit der echten Schrift und Sprache
let tabFitW = 0;
function fitTabs(force) {
  const list = $('.tablist'), w = list.clientWidth;
  if (!w || (!force && w === tabFitW)) return;
  tabFitW = w;
  list.style.fontSize = '20px';
  let text = 0, pad = 0;
  for (const b of list.children) {
    const r = document.createRange(); r.selectNodeContents(b);
    text += r.getBoundingClientRect().width;
    const cs = getComputedStyle(b); pad += parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  }
  list.style.fontSize = (text ? Math.max(10, Math.min(13.5, Math.floor(((w - pad - 2) / text) * 200) / 10)) : 12) + 'px';
}
addEventListener('resize', () => fitTabs());   // kein ResizeObserver auf der Reiterleiste: die neue Schriftgröße ändert ihre Höhe (Schleifenfehler)
function renderSettings() {
  const s = S.settings;
  $('#optLang').innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#optLang').value = LANG;
  $('#optTheme').value = s.theme || 'system';
  $('#optWishlist').checked = s.includeWishlist !== false;
  $('#optFanOrder').value = fanOrder();
  $('#optVariety').checked = s.variety !== false;
  $('#optPreferNew').checked = !!s.preferNew;
  $('#optKnownArtists').checked = s.knownArtists !== false;
  $('#optPlayerBar').checked = s.playerBar !== false;
  renderGenres();   // 0.9.66
  $('#username').value = S.me?.username || '';
  renderMe();
}

function render() { renderSetup(); renderNow(); renderMatches(); renderSoul(); renderTips(); renderScouts(); renderPromos(); }

// ---------- Ereignisse ----------
document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
const setView = (v) => { if (!(realTab in tabView)) return; tabView[realTab] = v; showTab(realTab); };
$('#viewFans').addEventListener('click', () => setView('fans'));
$('#viewTracks').addEventListener('click', () => setView('tracks'));

// Pfeiltasten wechseln den Reiter (und spulen dann nicht im Player)
$('.tablist').addEventListener('keydown', (e) => {
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')], i = tabs.indexOf(e.target);
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (i < 0 || j == null) return;
  e.preventDefault(); e.stopPropagation();
  const n = tabs[(j + tabs.length) % tabs.length]; n.focus(); n.click();
});

// ---------- 0.9.65: 👥 – wer hinter einem Track steckt (Promos und Gefolgt) ----------
// 0.9.66: wie Bandcamps „supported by“ – nur kleine quadratische Profilbilder, so viele je Reihe, wie in die Leiste passen;
// der Name steht im Tooltip (mit „✓ du folgst“), gefolgte haben ein ✓ in der Ecke, besuchte sind blasser.
// Klick öffnet das Profil wie eine Fan-Zeile (onFanClick, „schon besucht“). Öffnen per 👥 oder über den Zähltext der Zeile.
// Ein einziges Popover über der Liste; es rendert und sortiert die Liste nie neu.
const PPL_MAX = 48, PPL_OPEN_MS = 150, PPL_CLOSE_MS = 250, PPL_PX = 38, PPL_GAP = 4;
// 0.9.66: einfarbiges Symbol in Akzentfarbe statt 👥 (das graue Emoji verschwand unter Windows fast)
const PPL_ICON = '<svg class="pplsvg" viewBox="0 0 20 16" width="17" height="14" aria-hidden="true" focusable="false"><circle cx="7" cy="4.6" r="3" fill="currentColor"/>'
  + '<path d="M1 15c0-3.6 2.7-5.6 6-5.6s6 2 6 5.6z" fill="currentColor"/><circle cx="14.2" cy="5.4" r="2.5" fill="currentColor" opacity=".7"/>'
  + '<path d="M14.6 9.6c2.6.2 4.4 2 4.4 5.4h-4.6c0-2.2-.6-3.9-1.8-5.1.6-.2 1.3-.3 2-.3z" fill="currentColor" opacity=".7"/></svg>';
let ppl = null, pplTimer = 0;   // ppl: { list, tk, btn }
const pplEl = () => $('#pplPop');
const pplIsOpen = () => !!ppl && !pplEl().classList.contains('hidden');
// Name und Bild: gefolgte Fans zuerst, dann gespeicherte Profile, dann Seelenverwandte; e.by (Promos) als Ersatz für den Namen
function pplWho(e, u, j) {
  const a = S.follow?.fans?.[u], b = fans[u], c = S.soul?.twins?.[u];
  const name = [a?.name, b?.name, c?.name, e.by?.[j]].find((x) => x && x !== u) || u;
  return { u, name, img: a?.img ?? b?.img ?? c?.img ?? null };
}
function pplHtml(e) {
  const all = (e.byU || []).map((u, j) => pplWho(e, u, j)), more = all.length - PPL_MAX;
  const tiles = all.slice(0, more > 0 ? PPL_MAX - 1 : PPL_MAX).map((p) => {
    const fol = isFollowed(p.u), seen = !!S.visited?.[p.u];
    const tip = [p.name, fol ? t('✓ du folgst') : '', seen ? t('Schon besucht') : ''].filter(Boolean).join(' · ');
    return `<button class="ptile${fol ? ' followed' : ''}${seen ? ' visited' : ''}" data-fan="${esc(p.u)}" data-name="${esc(p.name)}" title="${esc(tip)}" aria-label="${esc(tip + ' · ' + t('Profil öffnen'))}">`
      + `${pic('av', avatarUrl(p.img), p.name)}${fol ? '<b class="fbadge" aria-hidden="true">✓</b>' : ''}</button>`;
  });
  if (more > 0) tiles.push(`<span class="pmore" title="${esc(t('{n} weitere', { n: more + 1 }))}">+${more + 1}</span>`);
  return `<div class="phead">${t('Wer hat das gekauft?')} <span class="muted">· ${all.length}</span></div><div class="pgrid">${tiles.join('')}</div><div class="ptip hidden" role="tooltip"></div>`;
}
// eigener Tooltip im Popover: Name, bei gefolgten „✓ du folgst“
function pplTip(tile) {
  const tip = pplEl().querySelector('.ptip');
  if (!tip) return;
  if (!tile) { tip.classList.add('hidden'); return; }
  tip.innerHTML = `<b>${esc(tile.dataset.name)}</b>${tile.classList.contains('followed') ? `<span class="fol">${t('✓ du folgst')}</span>` : ''}`;
  tip.classList.remove('hidden');
  const pop = pplEl(), pr = pop.getBoundingClientRect(), r = tile.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  const x = clamp(r.left + r.width / 2 - w / 2 - pr.left, 4, pop.clientWidth - w - 4);
  let y = r.top - pr.top + pop.scrollTop - h - 4;
  if (y < pop.scrollTop + 2) y = r.bottom - pr.top + pop.scrollTop + 4;   // oben kein Platz: darunter
  tip.style.left = Math.round(x) + 'px'; tip.style.top = Math.round(y) + 'px';
}
// unter der Zeile, unten zu wenig Platz → darüber; waagerecht in die Leiste geklemmt
function pplPlace() {
  const pop = pplEl(), row = ppl.btn.closest('.item') || ppl.btn, r = row.getBoundingClientRect(), W = innerWidth, H = innerHeight, m = 8;
  pop.style.maxWidth = (W - 2 * m) + 'px';
  // 0.9.66: so viele Bilder je Reihe, wie in die Leiste passen (Innenabstand 8 px links und rechts)
  const grid = pop.querySelector('.pgrid'), n = grid?.children.length || 1;
  if (grid) grid.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(n, Math.floor((W - 2 * m - 16 - 2 + PPL_GAP) / (PPL_PX + PPL_GAP))))}, ${PPL_PX}px)`;
  const w = pop.offsetWidth, h = pop.offsetHeight, b = ppl.btn.getBoundingClientRect();
  const below = r.bottom + 4 + h <= H - m || r.top - 4 - h < m && H - r.bottom > r.top;
  pop.style.left = Math.round(clamp(b.right - w, m, Math.max(m, W - w - m))) + 'px';
  pop.style.top = Math.round(below ? Math.min(r.bottom + 4, Math.max(m, H - m - h)) : Math.max(m, r.top - 4 - h)) + 'px';
  pop.classList.toggle('above', !below);
}
// 0.9.66: Auslöser ist der 👥-Knopf oder der Zähltext der Zeile – verankert wird immer am Knopf
const pplBtnOf = (el) => (el?.matches?.('button[data-ppl]') ? el : el?.closest('.item')?.querySelector('button.ppl[data-ppl]') || null);
function openPpl(btn, focus = false) {
  clearTimeout(pplTimer);
  btn = pplBtnOf(btn);
  if (!btn) return;
  const list = btn.dataset.list, e = cacheOf(list)[+btn.dataset.ppl];
  if (!e) return;
  if (ppl?.btn === btn && pplIsOpen()) { if (focus) pplEl().querySelector('.ptile')?.focus(); return; }
  if (ppl?.btn) ppl.btn.setAttribute('aria-expanded', 'false');
  ppl = { list, tk: e.tk, btn };
  const pop = pplEl();
  pop.innerHTML = pplHtml(e);
  pop.setAttribute('aria-label', t('Wer hat das gekauft?'));
  pop.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  pplPlace();
  if (focus) pop.querySelector('.ptile')?.focus();
}
function closePpl(refocus = false) {
  clearTimeout(pplTimer);
  if (!ppl) return;
  const b = ppl.btn;
  ppl = null;
  pplEl().classList.add('hidden');
  b.setAttribute('aria-expanded', 'false');
  if (refocus && b.isConnected) b.focus();
}
const pplLater = (fn, ms) => { clearTimeout(pplTimer); pplTimer = setTimeout(fn, ms); };
// nach einem Neuzeichnen der Liste (Tags kommen nach, Entfolgen): an die neue Zeile hängen oder schließen, wenn sie weg ist
function pplSync(list) {
  if (!pplIsOpen() || ppl.list !== list) return;
  const i = cacheOf(list).findIndex((x) => x.tk === ppl.tk), btn = i >= 0 ? $(`button[data-list="${list}"][data-ppl="${i}"]`) : null;
  if (!btn) { closePpl(); return; }
  const inPop = pplEl().contains(document.activeElement);
  ppl.btn = btn; btn.setAttribute('aria-expanded', 'true');
  if (!inPop) pplEl().innerHTML = pplHtml(cacheOf(list)[i]);   // Kachel mit Fokus nicht wegwerfen
  pplPlace();
}
['#promoList', '#scoutList'].forEach((id) => {
  const el = $(id);
  el.addEventListener('mouseover', (ev) => {
    const trig = ev.target.closest('button[data-ppl], [data-pplc]'), b = pplBtnOf(trig);
    if (b) { if (!(ppl?.btn === b && pplIsOpen())) pplLater(() => openPpl(b), PPL_OPEN_MS); else clearTimeout(pplTimer); }
  });
  el.addEventListener('mouseout', (ev) => {
    const trig = ev.target.closest('button[data-ppl], [data-pplc]'), b = pplBtnOf(trig);
    if (!b || trig.contains(ev.relatedTarget)) return;
    if (pplIsOpen() && ppl.btn === b) { if (!pplEl().contains(ev.relatedTarget)) pplLater(closePpl, PPL_CLOSE_MS); }
    else clearTimeout(pplTimer);   // nur kurz drübergefahren: nicht öffnen
  });
  el.addEventListener('scroll', () => { if (pplIsOpen() && ppl.list === el.dataset.ppl) closePpl(); }, { passive: true });
  el.dataset.ppl = id === '#promoList' ? 'promos' : 'scouts';
});
pplEl().addEventListener('mouseenter', () => clearTimeout(pplTimer));
pplEl().addEventListener('mouseleave', (ev) => { pplTip(null); if (pplIsOpen() && !ppl.btn.contains(ev.relatedTarget) && !ev.relatedTarget?.closest?.('[data-pplc]')) pplLater(closePpl, PPL_CLOSE_MS); });
// 0.9.66: Tooltip beim Zeigen auf ein Bild bzw. beim Fokus per Tastatur
pplEl().addEventListener('mouseover', (ev) => pplTip(ev.target.closest('.ptile')));
pplEl().addEventListener('focusin', (ev) => pplTip(ev.target.closest('.ptile')));
pplEl().addEventListener('focusout', (ev) => { if (pplIsOpen() && ev.relatedTarget && !pplEl().contains(ev.relatedTarget) && ev.relatedTarget !== ppl.btn) closePpl(); });
document.addEventListener('pointerdown', (ev) => { if (pplIsOpen() && !pplEl().contains(ev.target) && !ppl.btn.contains(ev.target)) closePpl(); }, true);
addEventListener('resize', () => { if (pplIsOpen()) pplPlace(); });

function onFanClick(e) {
  if (e.target.closest('#rankInfo')) { toast(rankHelp(), 20000); return; }   // Klick auf die Meldung schließt sie
  if (e.target.closest('#soulInfo')) { toast(soulHelp(), 20000); return; }
  if (e.target.closest('#soulMore')) { soulShow += SOUL_PAGE; renderSoul(); $('#soulList .item:nth-child(' + (soulShow - SOUL_PAGE + 2) + ') .open')?.focus(); return; }
  const u = e.target.closest('[data-fan]')?.dataset.fan;
  if (!u) return;
  S.visited[u] = Date.now();   // Markierung „schon besucht“
  store.set({ visited: S.visited });
  e.target.closest('.item, .ptile')?.classList.add('visited');   // 0.9.65: auch Kacheln im 👥-Popover
  openUrl(`https://bandcamp.com/${encodeURIComponent(u)}`);
}
$('#matchList').addEventListener('click', onFanClick);
$('#soulList').addEventListener('click', onFanClick);
$('#pplPop').addEventListener('click', onFanClick);

function onTrackClick(ev) {
  const b = ev.target.closest('button[data-list]');
  if (!b) return;
  const cache = cacheOf(b.dataset.list);
  const i = +(b.dataset.open ?? b.dataset.play ?? b.dataset.like ?? b.dataset.hide ?? b.dataset.ppl);
  const e = cache[i];
  if (!e) return;
  if (b.dataset.ppl != null) { openPpl(b, !ev.detail); return; }   // Klick bzw. Enter (detail 0: Tastatur → Fokus in die Kacheln)
  if (b.dataset.open != null) { if (e.url) openUrl(e.url); return; }
  if (b.dataset.play != null) {
    if (playing?.tk === e.tk && audio.getAttribute('src') && !audio.error) { audio.paused ? audio.play().catch(() => {}) : audio.pause(); return; }
    play(e, b.dataset.list); return;
  }
  if (b.dataset.like != null) { toggleLike(e); return; }
  if (b.dataset.hide != null) {
    S.hidden[e.tk] = packSong(e);   // genug, um es später im Fenster „Ausgeblendete Lieder“ zu zeigen und anzuhören
    store.set({ hidden: S.hidden });
    addTaste(e, 'hide');   // 0.9.56: Geschmacks-Signal mit den Fans, die es vorgeschlagen haben
    renderList(b.dataset.list);
  }
}
$('#tipsList').addEventListener('click', onTrackClick);
// 0.9.66: Genre-Filter in den Einstellungen, Hinweis über den Listen
$('#genreSec').addEventListener('click', onGenreClick);
for (const [id, mode] of [['#genreIncIn', 'inc'], ['#genreExcIn', 'exc']]) {
  $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addTypedTag(mode); });
  $(id).addEventListener('focus', fillTagSuggestions);
}
document.querySelectorAll('[data-genreadd]').forEach((b) => b.addEventListener('click', () => addTypedTag(b.dataset.genreadd)));
document.querySelectorAll('.sortrow .hhinfo').forEach((x) => x.addEventListener('click', (ev) => { if (ev.target.closest('.gfhint')) openGenres(); }));
// 0.9.66: Regler über der Liste – Stufen füllen; Ändern speichert und sortiert die Liste sofort neu
const CTL_OPTS = { minMatch: [MATCH_MIN, MATCH_MAX], minFansTips: [FANS_MIN, FANS_MAX], minFansScouts: [FANS_MIN, FANS_MAX] };
document.querySelectorAll('.ctlrow select').forEach((sel) => {
  const k = sel.dataset.set, r = CTL_OPTS[k];
  const vals = r ? Array.from({ length: r[1] - r[0] + 1 }, (_, i) => r[0] + i) : REFRESH_STEPS;
  sel.innerHTML = vals.map((v) => `<option value="${v}">${v}</option>`).join('');
  sel.addEventListener('change', async (e) => {
    const v = +e.target.value;
    S.settings[k] = r ? clampInt(v, r[0], r[1], DEFAULTS[k]) : nearestStep(v, REFRESH_STEPS, DEFAULTS.soulRefresh);
    if (k === 'minMatch') { unfreeze(); renderMatches(); renderSoul(); renderTips(); renderScouts(); renderPromos(); }   // auch soulTop und Promos
    else if (k === 'minFansScouts') { unfreeze('scouts'); renderScouts(); }
    else { unfreeze('tips'); renderTips(); }
    renderAction();
    await store.set({ settings: S.settings });
  });
});
$('#scoutList').addEventListener('click', onTrackClick);
$('#promoList').addEventListener('click', onTrackClick);
// 0.9.59: der Knopf oben (Suche, Aktualisieren) sortiert die Liste des Reiters neu
$('#btnAction').addEventListener('click', () => {
  const run = $('#btnAction')._run;
  if (!run) return;
  const k = activeTab();
  unfreeze(k === 'match' ? 'tips' : k);
  run();
});
// 0.9.59: „Neu sortieren“ und „Gehörte ausblenden“ (eine Einstellung für alle Tracklisten)
document.querySelectorAll('.sortrow .resort').forEach((b) => b.addEventListener('click', () => {
  const l = b.closest('.sortrow').dataset.list;
  unfreeze(l); renderList(l);
  $(`.sortrow[data-list="${l}"] input`)?.focus();   // der Link selbst verschwindet
}));
// 0.9.60: „Alle gehörten ausblenden“ mit Rückfrage unter der Zeile
document.querySelectorAll('.sortrow .bulkhide').forEach((b) => b.addEventListener('click', () => {
  const row = b.closest('.sortrow'), ask = row.querySelector('.bulkask'), n = heardToHide().length;
  if (!n) return;
  document.querySelectorAll('.sortrow .bulkask').forEach((x) => x !== ask && x.classList.add('hidden'));
  ask.querySelector('.bulktxt').textContent = t('{n} gehörte Tracks nicht mehr vorschlagen? Sie zählen wie ✕ (gefällt mir nicht). Zurückholen geht unter ‚Ausgeblendete zurückholen‘.', { n });
  ask.classList.remove('hidden');
  ask.querySelector('.bulkyes').focus();
}));
document.querySelectorAll('.sortrow .bulkno').forEach((b) => b.addEventListener('click', () => {
  const row = b.closest('.sortrow');
  row.querySelector('.bulkask').classList.add('hidden');
  row.querySelector('.bulkhide').focus();
}));
document.querySelectorAll('.sortrow .bulkyes').forEach((b) => b.addEventListener('click', () => {
  const row = b.closest('.sortrow');
  row.querySelector('.bulkask').classList.add('hidden');
  hideAllHeard();
  row.querySelector('input').focus();
}));
document.querySelectorAll('.sortrow input').forEach((c) => c.addEventListener('change', (ev) => {
  S.settings.hideHeard = ev.target.checked;
  store.set({ settings: S.settings });
  unfreeze(); renderTips(); renderScouts(); renderPromos();
}));
$('#soulAuto').addEventListener('change', (e) => (e.target.checked ? startAuto() : stopAuto('user')));

$('#btnSetup').addEventListener('click', () => loadMe($('#setupUser').value));
$('#setupUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadMe($('#setupUser').value); });

// Einstellungen als Dialog: Hintergrund nicht bedienbar, Fokus hinein und zurück, Escape schließt
const showSettings = (on) => {
  $('#settings').classList.toggle('hidden', !on);
  $('#main').inert = on; $('#player').inert = on; $('#plFallback').inert = on;
  if (on) { renderSettings(); $('#btnCloseSettings').focus(); } else $('#btnSettings').focus();
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (welcomeOpen()) { showWelcome(false); return; }   // 0.9.68: Begrüßung liegt über allem
  if (pplIsOpen()) { closePpl(true); return; }   // 0.9.65: erst das 👥-Popover
  if (!$('#hiddenDlg').classList.contains('hidden')) showHidden(false);
  else if (historyOpen()) showHistory(false);
  else if (!$('#settings').classList.contains('hidden')) showSettings(false);
});
$('#toast').addEventListener('click', () => $('#toast').classList.add('hidden'));
// ---------- 0.9.68: Begrüßung beim ersten Öffnen ----------
// Einmal zeigen (Speicher: welcomed), danach nur über „Begrüßung erneut zeigen“ in den Einstellungen. Wer schon Daten hat
// (eigene Sammlung oder Fan-Profile), bekommt sie nach dem Update nicht – welcomed wird still gesetzt.
const welcomeOpen = () => !$('#welcome').classList.contains('hidden');
function showWelcome(on) {
  $('#welcome').classList.toggle('hidden', !on);
  $('#main').inert = on || !$('#settings').classList.contains('hidden');
  $('#player').inert = $('#plFallback').inert = $('#main').inert;
  if (on) { $('#btnWelcome').focus(); return; }
  store.set({ welcomed: true });
  if (!S.me) $('#setupUser').focus(); else $('#btnSettings').focus();
}
async function welcomeOnStart() {
  if ((await store.get('welcomed')).welcomed) return;
  if (S.me || Object.keys(fans).length) { await store.set({ welcomed: true }); return; }
  showWelcome(true);
}
$('#btnWelcome').addEventListener('click', () => showWelcome(false));
$('#operaHint').classList.toggle('hidden', !/\bOPR\//.test(navigator.userAgent));   // 0.9.75: nur in Opera – wie man TrackPilot in der Seitenleiste anheftet
$('#btnWelcomeAgain').addEventListener('click', () => { showSettings(false); showWelcome(true); });
$('#btnSettings').addEventListener('click', () => showSettings(true));
// tatsächlich eingestelltes Tastenkürzel anzeigen (falls in Chrome geändert)
chrome.commands?.getAll?.().then((cs) => {
  const k = cs.find((c) => c.name === 'toggle-panel')?.shortcut;
  $('#keyName').textContent = k ? k.replace(/\+/g, ' + ') : t('nicht belegt');
}).catch(() => {});
$('#btnCloseSettings').addEventListener('click', () => showSettings(false));
$('#btnLoadMe').addEventListener('click', async () => {
  S.settings.includeWishlist = $('#optWishlist').checked;
  await store.set({ settings: S.settings });
  await loadMe($('#username').value);
  renderMe();
});
$('#optLang').addEventListener('change', async (e) => {
  S.settings.lang = e.target.value;
  await store.set({ settings: S.settings });
  if (!cur?.scanning) setStatus('');   // Statuszeile ist fertig übersetzt gespeichert – während einer Suche erneuert sie sich jede Sekunde
  applyLook(); renderSettings(); render(); renderPending();
});
$('#optTheme').addEventListener('change', async (e) => {
  S.settings.theme = e.target.value;
  await store.set({ settings: S.settings });
  document.documentElement.dataset.theme = S.settings.theme;
});
$('#optFanOrder').addEventListener('change', async (e) => {
  S.settings.fanOrder = e.target.value === 'first' ? 'first' : 'new';
  await store.set({ settings: S.settings });
  renderAction();
  toast(t('Gilt ab der nächsten Suche.'));
});
$('#optWishlist').addEventListener('change', async (e) => {
  S.settings.includeWishlist = e.target.checked;
  await store.set({ settings: S.settings });
  toast(t('Gilt ab dem nächsten „Wishlist laden“.'));
});
$('#optVariety').addEventListener('change', async (e) => {
  S.settings.variety = e.target.checked;
  await store.set({ settings: S.settings });
  unfreeze(); renderTips(); renderScouts();
});
// 0.9.56: Neuere bevorzugen (0.9.66: die Regler sitzen über den Listen)
$('#optPreferNew').addEventListener('change', async (e) => {
  S.settings.preferNew = e.target.checked;
  await store.set({ settings: S.settings });
  unfreeze(); renderTips(); renderScouts();
});
// 0.9.70: Player-Leiste auf Bandcamp – die Content-Skripte hören auf storage.onChanged
$('#optPlayerBar').addEventListener('change', async (e) => {
  S.settings.playerBar = e.target.checked;
  await store.set({ settings: S.settings });
});
// 0.9.60: Bekannte Künstler bevorzugen – sortiert neu
$('#optKnownArtists').addEventListener('change', async (e) => {
  S.settings.knownArtists = e.target.checked;
  await store.set({ settings: S.settings });
  unfreeze(); renderTips(); renderScouts(); renderPromos();
});
$('#btnExport').addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(await store.get(null))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trackpilot-datenbank-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$('#fileImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';   // dieselbe Datei später nochmal wählbar
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('settings' in data || 'me' in data)) throw new Error(t('keine TrackPilot-Datenbank'));
    releaseJob++; followJob++; soulJob++; dataGen++; scoutsRunning = false; soulRunning = false; autoGo = null; stopAuto('reset'); setStatus('');
    // Bandcamps Limit ist jetzt, nicht zur Zeit der Sicherung: den aktuellen Stand behalten
    const { reqTokens, ...rest } = data, lim = await keepLimit();
    await store.clear(); await store.set({ ...rest, welcomed: true });
    cur = null; pending = null; tipsOn = false; nowTrack = ''; unfreeze();
    await loadAll(); restoreLimit(lim); applyLook(); restoreView(data.view); renderSettings(); render(); syncTab();
    toast(t('Datenbank importiert.'));
  } catch (err) { toast(t('Datenbank konnte nicht gelesen werden: {err}', { err: err.message })); }
});
// ---------- Fenster „Ausgeblendete Lieder“: reinhören, einzeln zurückholen, speichern ----------
// Ältere Versionen haben nur die ID gemerkt: Titel, Künstler und Link aus den gespeicherten Fans suchen
function hiddenEntries() {
  const need = new Set(Object.keys(S.hidden).filter((tk) => typeof S.hidden[tk] !== 'object')), found = {};
  const look = (k, meta) => { const e = trackOf(k, meta); if (need.has(e.tk) && !found[e.tk]) found[e.tk] = e; };
  if (need.size) {
    for (const f of Object.values(fans)) for (const [k, m] of Object.entries(f.meta || {})) look(k, m);
    for (const f of Object.values(S.follow?.fans || {})) for (const [k, m] of f.items || []) look(k, m);
  }
  return Object.entries(S.hidden).map(([tk, v]) => (v && typeof v === 'object'
    ? (v.t || v.al ? unpackSong(tk, v) : { ...unpackSong(tk, v), album: t('Unbekanntes Lied') })   // 0.9.60: ohne bekannte Daten ausgeblendet
    : found[tk] ? { ...found[tk], at: 0 } : { tk, title: '', album: t('Unbekanntes Lied'), artist: '', url: null, trackId: tk[0] === 't' ? tk.slice(1) : null, albumId: null, at: 0 }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}
function renderHidden() {
  const n = hiddenCache.length, k = hiddenPick.size;
  $('#hiddenInfo').textContent = t(n > 1 ? '{n} ausgeblendete Lieder. Hör rein und hol zurück, was du aus Versehen ausgeblendet hast.'
    : n ? '1 ausgeblendetes Lied. Hör rein und hol es zurück, falls du es aus Versehen ausgeblendet hast.' : 'Keine ausgeblendeten Lieder.', { n });
  $('#btnHiddenAll').hidden = !n;
  const all = n && k === n;   // beide Texte liegen übereinander, der Knopf behält seine Breite
  $('#btnHiddenAll').innerHTML = `<span${all ? ' class="off"' : ''}>${esc(t('Alle auswählen'))}</span><span${all ? '' : ' class="off"'}>${esc(t('Auswahl aufheben'))}</span>`;
  $('#hiddenCount').textContent = k > 1 ? t('{n} werden zurückgeholt', { n: k }) : k ? t('1 wird zurückgeholt') : n ? t('Nichts ausgewählt') : '';
  $('#btnHiddenSave').textContent = t(n ? 'Speichern' : 'Schließen');
  $('#hiddenList').innerHTML = hiddenCache.map((e, i) => {
    const on = hiddenPick.has(e.tk), name = e.title || e.album;
    return `<li class="item hitem${on ? ' picked' : ''}">
    <button class="open" data-hopen="${i}" title="${t('Auf Bandcamp öffnen')}"${e.url ? '' : ' disabled'}>
      ${pic('cover', coverUrl(e.art), name || '?')}
      <span class="txt"><span class="a">${esc(name)}</span><span class="b">${esc(e.artist)}${e.title && e.album ? ' · ' + esc(e.album) : ''}</span></span>
    </button>
    <button class="icon" data-list="hidden" data-play="${i}" title="${t('Hier anhören')}" aria-label="${t('Hier anhören')}" aria-pressed="false"${e.url ? '' : ' disabled'}>▶</button>
    <button class="pick" data-hpick="${i}" aria-pressed="${on}" title="${t('Für Zurückholen auswählen')}"><span class="chk" aria-hidden="true">✓</span>${t('Zurückholen')}</button>
  </li>`;
  }).join('');
  markPlaying();
}
const hiddenOpen = () => !$('#hiddenDlg').classList.contains('hidden');
function showHidden(on) {
  $('#hiddenDlg').classList.toggle('hidden', !on);
  $('#settings').inert = on; $('#player').inert = $('#plFallback').inert = !on;   // im Fenster bleibt der Player unten sichtbar und bedienbar
  document.body.classList.toggle('dlg-play', on);
  if (on) {
    hiddenCache = hiddenEntries(); hiddenPick = new Set();
    renderHidden();
    $('#hiddenDlg').scrollTop = 0;
    $('#btnHiddenCancel').focus();
  } else {
    hiddenCache = []; hiddenPick = new Set(); $('#hiddenList').innerHTML = '';
    $('#btnUnhide').focus();
  }
}
$('#btnUnhide').addEventListener('click', () => showHidden(true));

// ---------- Fenster „Wiedergabeverlauf“: die zuletzt angehörten Lieder nochmal anhören und liken ----------
const historyOpen = () => !$('#historyDlg').classList.contains('hidden');
function renderHistory() {
  const n = historyCache.length, today = new Date().toDateString();
  $('#historyInfo').textContent = t(n > 1 ? 'Die letzten {n} Lieder, die du hier angehört hast.' : n ? 'Das letzte Lied, das du hier angehört hast.'
    : 'Noch nichts angehört. Lieder, die du hier abspielst, erscheinen in diesem Verlauf.', { n });
  $('#historyList').innerHTML = historyCache.map((e, i) => {
    const d = new Date(e.at);
    const when = d.toDateString() === today ? d.toLocaleTimeString(locale(), { timeStyle: 'short' }) : d.toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
    return trackItem(e, i, 'history', when, false);
  }).join('');
  markPlaying();
}
function showHistory(on) {
  $('#historyDlg').classList.toggle('hidden', !on);
  $('#settings').inert = on; $('#player').inert = $('#plFallback').inert = !on;   // im Fenster bleibt der Player unten sichtbar und bedienbar
  document.body.classList.toggle('dlg-play', on);
  if (on) {
    historyCache = S.history.map((h) => unpackSong(h.tk, h));   // Momentaufnahme: Abspielen hier sortiert die Liste nicht während des Hörens um
    renderHistory();
    $('#historyDlg').scrollTop = 0;
    $('#btnHistoryClose').focus();
  } else {
    historyCache = []; $('#historyList').innerHTML = '';
    $('#btnHistory').focus();
  }
}
$('#btnHistory').addEventListener('click', () => showHistory(true));
$('#btnHistoryClose').addEventListener('click', () => showHistory(false));
$('#historyList').addEventListener('click', onTrackClick);
$('#btnHiddenCancel').addEventListener('click', () => showHidden(false));
$('#btnHiddenAll').addEventListener('click', () => {
  hiddenPick = hiddenPick.size === hiddenCache.length ? new Set() : new Set(hiddenCache.map((e) => e.tk));
  renderHidden();
});
$('#btnHiddenSave').addEventListener('click', async () => {
  const back = [...hiddenPick].filter((tk) => S.hidden[tk]);
  if (back.length) {
    for (const tk of back) delete S.hidden[tk];
    await store.set({ hidden: S.hidden });
    removeTaste(back, 'hide');   // zurückgeholt: das Ausblenden zählt nicht mehr als Signal
    renderTips(); renderScouts(); renderPromos();
    toast(back.length > 1 ? t('{n} Lieder sind wieder da.', { n: back.length }) : t('Das Lied ist wieder da.'));
  }
  showHidden(false);
});
$('#hiddenList').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || b.disabled) return;
  const e = hiddenCache[+(b.dataset.hopen ?? b.dataset.play ?? b.dataset.hpick)];
  if (!e) return;
  if (b.dataset.hopen != null) { if (e.url) openUrl(e.url); return; }
  if (b.dataset.play != null) {
    if (playing?.tk === e.tk && audio.getAttribute('src') && !audio.error) { audio.paused ? audio.play().catch(() => {}) : audio.pause(); return; }
    play(e, 'hidden'); return;
  }
  hiddenPick.has(e.tk) ? hiddenPick.delete(e.tk) : hiddenPick.add(e.tk);
  renderHidden();
  $(`#hiddenList [data-hpick="${b.dataset.hpick}"]`)?.focus();   // Fokus bleibt auf dem Knopf, auch nach dem Neuzeichnen
});
// „Cache leeren“: gespeicherte Fan-Profile, Käuferlisten, Tags und die Tracksuche löschen – Wishlist, Likes, Ausgeblendete, Verlauf,
// Geschmacks-Signale (taste, 0.9.56), „gehört“ (heard, 0.9.59) und Einstellungen bleiben
$('#btnClearCache').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = t('Wirklich leeren? Nochmal klicken');
    setTimeout(() => { delete b.dataset.armed; b.textContent = t('Cache leeren'); }, 4000);
    return;
  }
  delete b.dataset.armed; b.textContent = t('Cache leeren');
  releaseJob++; followJob++; prefetchJob++; soulJob++; dataGen++; autoGo = null; stopAuto('reset'); setStatus('');
  scoutsRunning = false; soulRunning = false; tipsOn = false; nowTrack = ''; cur = null; pre = null;
  const stored = Object.keys(await store.get(null)).filter((k) => k.startsWith('fan:') || k.startsWith('seed:'));   // auch aus dem anderen Fenster
  await store.remove([...new Set([...stored, ...Object.keys(fans).map((u) => 'fan:' + u)]), 'rel', 'tags', 'follow', 'view', 'soul', 'visited']);
  fans = {}; S.rel = {}; S.tags = {}; S.follow = null; S.soul = { seeds: {} }; S.visited = {}; unfreeze();   // „gehört“ (heard) bleibt
  clearNow(); renderMe(); render(); syncTab(); tasteTagsLoad();
  toast(t('Cache geleert. Fans werden bei der nächsten Suche neu geladen.'));
});
// Zweistufig statt confirm(), damit nichts aus Versehen gelöscht wird
$('#btnReset').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = t('Wirklich alles löschen? Nochmal klicken');
    setTimeout(() => { delete b.dataset.armed; b.textContent = t('Alles löschen'); }, 4000);
    return;
  }
  releaseJob++; followJob++; soulJob++; dataGen++; autoGo = null; stopAuto('reset'); setStatus('');
  scoutsRunning = false; soulRunning = false; tipsOn = false; nowTrack = '';
  const lim = await keepLimit();
  await store.clear(); await store.set({ welcomed: true });   // 0.9.68: Begrüßung nicht nochmal
  await loadAll(); restoreLimit(lim); cur = null; pending = null; closePlayer(); unfreeze();
  applyLook(); clearNow(); restoreView(null); renderSettings(); render(); syncTab(); toast(t('Alles gelöscht.'));
});

// 0.9.70: BPM (bpm.js) und Wellenform für die Player-Leiste; nur Bandcamps Server
async function barAnalyze(url) {
  try {
    if (!/^https:\/\/([\w-]+\.)*(bcbits|bandcamp)\.com\//.test(url)) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await tpAnalyze(await res.arrayBuffer());
  } catch { return null; }
}

// Für das Tastenkürzel: der Hintergrund weiß so, dass die Leiste in diesem Fenster offen ist
// Startet Chrome den Hintergrund neu, reißt die Verbindung ab – dann gleich neu verbinden
(function connectPanel(first = true) {
  const port = chrome.runtime.connect({ name: 'panel' });
  chrome.windows.getCurrent().then((w) => {
    myWindowId = w.id;
    port.postMessage({ windowId: w.id });
    if (first) cleanLikeTabs();
  }).catch(() => {});
  port.onMessage.addListener((m) => {
    if (m.type === 'close') window.close();
    // 0.9.70: Player-Leiste auf Bandcamp fragt nach BPM und Wellenform (über den Hintergrund) – hier gibt es AudioContext und keine CORS-Sperre
    if (m.type === 'bpm') barAnalyze(m.url).then((res) => { try { port.postMessage({ type: 'bpmRes', id: m.id, res }); } catch {} });
  });
  port.onDisconnect.addListener(() => setTimeout(() => connectPanel(false), 500));
})();

(async () => {
  await loadAll();
  applyLook();
  restoreView((await store.get('view')).view);
  render();
  if (!S.me) $('#setupUser').focus();
  else { refreshMe(); refreshFollowed(); tasteTagsLoad(); }   // Tags für den Geschmack nach denen der sichtbaren Listen
  await welcomeOnStart();   // 0.9.68
  syncTab();
})();
