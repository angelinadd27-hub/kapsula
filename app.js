(function () {
  "use strict";
  var DIRS = { office: "Креативный офис", sport: "Ретро-спорт", seventies: "Мягкие 70-е", evening: "Вечер", cold: "Холод", mine: "Мой образ" };
  var CATS = { top: "Верх", layer: "Пиджаки и кардиганы", bottom: "Низ", outer: "Верхняя одежда", shoes: "Обувь", dress: "Платья" };
  var SLOTS = [
    ["outer", "Верхняя одежда", ["outer"]],
    ["mid", "Пиджак или кардиган", ["mid"]],
    ["base", "Верх", ["base", "warm"]],
    ["tank", "Майка под низ", ["tank"]],
    ["bottom", "Низ", ["bottom", "skirt", "dress"]],
    ["shoes", "Обувь", ["shoes"]]
  ];
  var SPB = { name: "Санкт-Петербург", lat: 59.9386, lon: 30.3141 };
  var D = null, LOOK = {}, ITEM = {};
  var S = { tab: "today", fav: [], my: [], myItems: [], city: SPB, wx: null, manual: { t: 4, rain: true }, skip: 0,
    fDir: "all", fT: "all", fCat: "all", q: "", mineSeg: "my", rot: {}, build: null, buildTitle: "", buildPhoto: null, seed: 1 };
  var tg = null;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function plural(n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : (m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c); }
  function sgn(t) { return (t > 0 ? "+" : "") + t; }

  /* ---------- storage ---------- */
  // Three modes: own server (synced between iPhone and iPad), Telegram CloudStorage, or this device only.
  var SRV = null; // server state {v, kv, photos} when the sync server answered
  var cloudOK = function () { return tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9"); };
  var pending = 0;
  function net(method, url, data, type) {
    pending++;
    return fetch(url, { method: method, body: data, credentials: "same-origin", headers: type ? { "Content-Type": type } : {} })
      .then(function (r) {
        if (r.status === 401) { showLogin(); throw new Error("auth"); }
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (j) { if (SRV && j && j.v) SRV.v = j.v; return j; })
      .catch(function (e) { if (e.message !== "auth") toast("Нет связи с сервером, изменение не сохранилось"); throw e; })
      .finally(function () { pending--; });
  }
  var kv = {
    get: function (keys, cb) {
      if (SRV) { var r = {}; keys.forEach(function (k) { r[k] = SRV.kv[k] == null ? null : SRV.kv[k]; }); cb(r); return; }
      if (cloudOK()) { tg.CloudStorage.getItems(keys, function (e, v) { cb(e ? {} : v || {}); }); return; }
      var o = {}; keys.forEach(function (k) { try { o[k] = localStorage.getItem("cap_" + k); } catch (e) {} }); cb(o);
    },
    set: function (k, v) {
      var s = JSON.stringify(v);
      if (SRV) { SRV.kv[k] = s; net("PUT", "api/kv/" + k, s, "text/plain").catch(function () {}); return; }
      if (cloudOK()) { tg.CloudStorage.setItem(k, s); return; }
      try { localStorage.setItem("cap_" + k, s); } catch (e) {}
    },
    del: function (k) {
      if (SRV) { delete SRV.kv[k]; net("DELETE", "api/kv/" + k).catch(function () {}); return; }
      if (cloudOK()) { tg.CloudStorage.removeItem(k); return; } try { localStorage.removeItem("cap_" + k); } catch (e) {}
    }
  };
  function parse(s, d) { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } }
  var idb = (function () {
    var p = null;
    function open() {
      if (p) return p;
      p = new Promise(function (res, rej) {
        try { var r = indexedDB.open("kapsula", 1); r.onupgradeneeded = function () { r.result.createObjectStore("kv"); }; r.onsuccess = function () { res(r.result); }; r.onerror = rej; } catch (e) { rej(e); }
      });
      return p;
    }
    function tx(mode, fn) { return open().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction("kv", mode), st = t.objectStore("kv"), r = fn(st); t.oncomplete = function () { res(r && r.result); }; t.onerror = rej; }); }); }
    function isPh(k) { return k.indexOf("ph_") === 0; }
    return {
      get: function (k) {
        if (SRV) {
          if (isPh(k)) return Promise.resolve(SRV.photos[k] ? "p/" + k + "?v=" + SRV.photos[k] : null);
          return Promise.resolve(parse(SRV.kv["db_" + k], null));
        }
        return tx("readonly", function (s) { return s.get(k); }).catch(function () { return null; });
      },
      set: function (k, v) {
        if (SRV) {
          if (isPh(k)) return net("PUT", "api/photo/" + k, v, "text/plain").then(function (j) { SRV.photos[k] = j.t; }).catch(function () {});
          kv.set("db_" + k, v); return Promise.resolve();
        }
        return tx("readwrite", function (s) { s.put(v, k); }).catch(function () { toast("Не удалось сохранить фото на устройстве"); });
      },
      del: function (k) {
        if (SRV) {
          if (isPh(k)) { delete SRV.photos[k]; return net("DELETE", "api/photo/" + k).catch(function () {}); }
          kv.del("db_" + k); return Promise.resolve();
        }
        return tx("readwrite", function (s) { s.delete(k); }).catch(function () {});
      }
    };
  })();
  var photos = {};
  function loadPhoto(k) { if (k in photos) return Promise.resolve(photos[k]); return idb.get("ph_" + k).then(function (v) { photos[k] = v || null; return photos[k]; }); }
  function resizeFile(file, max) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        var im = new Image();
        im.onload = function () { var s = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.82)); };
        im.onerror = rej; im.src = r.result;
      };
      r.onerror = rej; r.readAsDataURL(file);
    });
  }

  /* ---------- weather ---------- */
  var RAIN = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
  function wxText(c) { return c === 0 ? "Ясно" : c <= 3 ? "Облачно" : c <= 48 ? "Туман" : (c <= 67 || (c >= 80 && c <= 82)) ? "Дождь" : (c <= 77 || c === 85 || c === 86) ? "Снег" : "Гроза"; }
  function loadWeather() {
    var u = "https://api.open-meteo.com/v1/forecast?latitude=" + S.city.lat + "&longitude=" + S.city.lon +
      "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=precipitation_probability_max,temperature_2m_min,temperature_2m_max" +
      "&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code&timezone=auto&forecast_days=1";
    fetch(u).then(function (r) { return r.json(); }).then(function (j) {
      var c = j.current, p = (j.daily.precipitation_probability_max || [0])[0] || 0;
      S.wx = { t: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), code: c.weather_code, rain: RAIN.indexOf(c.weather_code) >= 0 || p >= 50,
        p: p, wind: Math.round(c.wind_speed_10m), min: Math.round(j.daily.temperature_2m_min[0]), max: Math.round(j.daily.temperature_2m_max[0]) };
      var hh = j.hourly || { time: [] };
      S.hours = hh.time.map(function (tm, i) { return { h: +tm.slice(11, 13), t: Math.round(hh.temperature_2m[i]), feels: Math.round(hh.apparent_temperature[i]), p: hh.precipitation_probability[i] || 0, code: hh.weather_code[i] }; });
      S.skip = 0; if (S.tab === "today") render();
    }).catch(function () { S.wx = null; if (S.tab === "today") render(); });
  }
  function cond() { return S.wx ? { t: S.wx.feels, rain: S.wx.rain } : S.manual; }

  /* ---------- looks: ready-made + my own ---------- */
  function allItems() { return D.items.concat(S.myItems); }
  function look(k) { return LOOK[k]; }
  function indexMy() { S.my.forEach(function (m) { LOOK[m.key] = m; }); }
  function hasItem(l, f) { return l.items.some(function (i) { return ITEM[i] && f(ITEM[i]); }); }
  function score(l, c) {
    var lo = l.t[0], hi = l.t[1], s = 0;
    if (c.t < lo) s += (lo - c.t) * 3; else if (c.t > hi) s += (c.t - hi) * 3;
    if (c.rain) { if (hasItem(l, function (x) { return x.rain; })) s -= 2; if (hasItem(l, function (x) { return x.suede; })) s += 3; }
    if (S.fav.indexOf(l.key) >= 0) s -= 0.5;
    return s;
  }
  function picks() {
    var c = cond(), ranked = D.looks.slice().sort(function (a, b) { return score(a, c) - score(b, c) || a.id - b.id; });
    var good = ranked.filter(function (l) { return score(l, c) < 6; }), pool = good.length >= 3 ? good : ranked.slice(0, 9);
    var k = (S.skip * 3) % pool.length, out = [];
    for (var i = 0; i < 3; i++) out.push(pool[(k + i) % pool.length]);
    return out;
  }

  /* ---------- outfit generator (rules from our styling sessions) ---------- */
  function rnd() { S.seed = (S.seed * 16807) % 2147483647; return (S.seed - 1) / 2147483646; }
  function pick(arr, w) {
    if (!arr.length) return null;
    var ws = arr.map(w || function () { return 1; }), tot = ws.reduce(function (a, b) { return a + b; }, 0), r = rnd() * tot;
    for (var i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }
  function usable(x, t) { return !x.off && !x.rare && !(x.summer && t < 15); }
  function generate(c, force) {
    var t = c.t, pool = allItems().filter(function (x) { return usable(x, t) && (!force || x.id !== force.id); });
    var F = function (subs, v) { return force && subs.indexOf(force.sub) >= 0 ? force : v; };
    function of(subs) { return pool.filter(function (x) { return subs.indexOf(x.sub) >= 0; }); }
    for (var tries = 0; tries < 80; tries++) {
      var b = {};
      b.outer = F(["outer"], pick(of(["outer"]).filter(function (x) { return !x.tr || (t >= x.tr[0] - 1 && t <= x.tr[1] + 1); }).filter(function (x) { return !(c.rain && x.suede); }),
        function (x) { return /букле/.test(x.name) && t <= 3 ? 4 : /Тренч/.test(x.name) ? 2 : 1; }));
      b.base = F(["base", "warm"], pick(of(["base", "warm"]), function (x) { return x.sub === "warm" ? (t <= 2 ? 3 : 1) : 1; }));
      if (!b.base) continue;
      if (b.base.crop || (force && force.sub === "tank")) b.tank = F(["tank"], pick(of(["tank"]).filter(function (x) { return !x.summer; })));
      if ((b.base.sub === "base" && t <= 12 && rnd() < 0.55) || (force && force.sub === "mid")) b.mid = F(["mid"], pick(of(["mid"])));
      b.bottom = F(["bottom", "skirt", "dress"], pick(of(["bottom", "skirt"]), function (x) { return x.sub === "skirt" ? 0.5 : 1; }));
      var sh = of(["shoes"]).filter(function (x) { return !(c.rain && x.suede); });
      if (b.bottom && b.bottom.sub === "skirt") sh = sh.filter(function (x) { return x.rain || /Adidas черные/.test(x.name); });
      b.shoes = F(["shoes"], pick(sh, function (x) { return x.rain ? (c.rain ? 5 : 2) : 1; }));
      var acc = [b.base, b.mid, b.bottom].filter(function (x) { return x && x.acc; }).length;
      if (acc > 1 || !b.bottom || !b.shoes) continue;
      var o = {}; Object.keys(b).forEach(function (k) { if (b[k]) o[k] = b[k].id; });
      return o;
    }
    return null;
  }
  function lower1(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  function short(x) { return x.name.replace(/\s*\(.*?\)/, "").split(" ").slice(0, 2).join(" "); }
  function buildItems(b) { return SLOTS.map(function (s) { return b[s[0]]; }).filter(Boolean); }
  function howFor(b, c) {
    var g = function (k) { return b[k] && ITEM[b[k]]; }, base = g("base"), bot = g("bottom"), mid = g("mid"), out = g("outer"), tank = g("tank"), sh = g("shoes");
    var r = [], tucked = false;
    var into = bot ? (bot.sub === "skirt" ? "юбку" : /Джинсы/.test(bot.name) ? "джинсы" : "брюки") : "низ";
    if (base) {
      if (base.crop) { r.push("Под короткий верх — " + lower1(tank ? short(tank) : "майка") + ", заправленная в " + into + ". Сам верх не заправляйте."); tucked = true; }
      else if (base.sub === "warm") r.push(/Водолазка/.test(base.name) ? "Водолазку заправьте в " + into + " полностью." : lower1(short(base)).replace(/^./, function (m) { return m.toUpperCase(); }) + " носите навыпуск, спереди можно слегка заправить.");
      else if (/Рубашка/.test(base.name) && !mid) r.push("Рубашку заправьте спереди или носите расстёгнутой поверх, как лёгкий жакет.");
      else { r.push((bot && bot.peplum) || (bot && bot.sub === "skirt") ? "Верх заправьте в " + into + " полностью." : "Французская заправка: перед заправьте в " + into + ", бока навыпуск."); tucked = true; }
    }
    if (mid) r.push(/Пиджак/.test(mid.name) ? "Пиджак носите открытым, рукава подтяните до середины предплечья." : /Кардиган/.test(mid.name) ? "Кардиган застегните на пару средних пуговиц." : "Олимпийку носите расстёгнутой.");
    if (bot && bot.peplum) r.push(tucked ? "Баску сбоку завяжите повыше, у талии." : "Баску сбоку завяжите пониже, на бедре.");
    if (bot && bot.sub === "skirt") r.push("Плотные чёрные колготки.");
    if (out) r.push(c.t <= 0 ? short(out) + " застегните, сверху объёмный шарф." : short(out) + " носите нараспашку.");
    if (sh && sh.rain && c.rain) r.push("Мартинсы не боятся луж.");
    return r;
  }
  function makeTitle(b) {
    var base = ITEM[b.base], bot = ITEM[b.bottom];
    if (!base || !bot) return "Мой образ";
    return short(base) + " и " + lower1(short(bot));
  }

  /* ======================================================================
     Личный помощник: «Мой день», дела, чемодан, пробелы, проверка покупки, ИИ-чат
     ====================================================================== */
  function todayKey(d) { d = d || new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function hm(s) { var m = /^(\d{1,2})[:.](\d{2})/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; }
  function fmtH(min) { return pad(Math.floor(min / 60)) + ":" + pad(min % 60); }
  var DAY = { key: null, ev: [], tasks: [], note: "", chk: {}, loaded: false }, TRIPS = [], noteTimer = null;
  function saveDay() { kv.set("day_" + DAY.key, { ev: DAY.ev, tasks: DAY.tasks, note: DAY.note, chk: DAY.chk }); }
  function loadDay(cb) {
    var k = todayKey();
    kv.get(["day_" + k, "trips"], function (v) {
      var d = parse(v["day_" + k], {}) || {};
      DAY = { key: k, ev: d.ev || [], tasks: d.tasks || [], note: d.note || "", chk: d.chk || {}, loaded: true };
      TRIPS = parse(v.trips, []) || [];
      if (readIncoming()) saveDay();
      cb && cb();
    });
  }

  /* ---------- events: from the iOS Shortcut link, clipboard, Telegram start_param, or typed by hand ---------- */
  function parseEvents(text) {
    var out = [];
    String(text || "").split(/\r?\n|;;/).forEach(function (line) {
      line = line.trim(); if (!line) return;
      var p = line.split("|").map(function (s) { return s.trim(); });
      if (p.length >= 3 && hm(p[0]) != null) {
        var s0 = hm(p[0]), e0 = hm(p[1]), allDay = s0 === 0 && (e0 === 0 || e0 === 1439 || e0 == null);
        out.push({ s: allDay ? "" : fmtH(s0), e: allDay || e0 == null ? "" : fmtH(e0), t: p[2] || "Событие", loc: p[3] || "" }); return;
      }
      if (p.length >= 2 && /весь день|all.?day/i.test(p[0])) { out.push({ s: "", e: "", t: p[1], loc: p[2] || "" }); return; }
      var m = /^(\d{1,2}[:.]\d{2})(?:\s*[-–—]\s*(\d{1,2}[:.]\d{2}))?\s*[|·,:-]?\s*(.+)$/.exec(line);
      if (m) out.push({ s: fmtH(hm(m[1])), e: m[2] ? fmtH(hm(m[2])) : "", t: m[3], loc: "" });
      else if (out.length === 0 && line.length < 80) out.push({ s: "", e: "", t: line, loc: "" });
    });
    return out.sort(function (a, b) { return (hm(a.s) || 0) - (hm(b.s) || 0); });
  }
  function b64urlText(s) { try { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return decodeURIComponent(escape(atob(s))); } catch (e) { return ""; } }
  function readIncoming() {
    var txt = null, m = /[#&]day=([^&]*)/.exec(location.hash);
    if (m) {
      try { txt = decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { txt = m[1]; }
      if (!/[\n|:]/.test(txt)) txt = b64urlText(m[1]) || txt;
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    } else if (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param && !readIncoming.done) {
      readIncoming.done = true; txt = b64urlText(tg.initDataUnsafe.start_param);
    }
    if (txt == null) return false;
    DAY.ev = parseEvents(txt); toast(DAY.ev.length ? "Календарь обновлён" : "На сегодня событий нет");
    return true;
  }
  var TAGS = [
    ["office", /встреч|созвон|офис|работ|клиент|презентац|совещ|собес|митинг|планерк|звонок|дедлайн|ревью/i],
    ["evening", /ужин|ресторан|театр|концерт|свидан|бар\b|вечерин|день рожд|кино|выставк|галере|опер|балет/i],
    ["sport", /спорт|зал\b|йог|пилатес|бег|трениров|фитнес|бассейн|танц|стретч/i],
    ["docs", /врач|клиник|больниц|анализ|мфц|банк|паспорт|нотари|посольств|госуслуг|стоматолог|поликлин/i],
    ["travel", /аэропорт|вокзал|поезд|рейс|самол[её]т|сапсан|ласточк|такси в/i],
    ["outdoor", /прогул|парк|пикник|экскурс|рынок|ярмарк|набережн/i]
  ];
  function tagsOf(ev) { var t = {}; ev.forEach(function (e) { TAGS.forEach(function (g) { if (g[1].test(e.t + " " + e.loc)) { t[g[0]] = t[g[0]] || []; t[g[0]].push(e); } }); }); return t; }

  /* ---------- hourly weather for the hours she is out ---------- */
  function dayWindow() {
    var st = DAY.ev.map(function (e) { return hm(e.s); }).filter(function (x) { return x != null; });
    var en = DAY.ev.map(function (e) { return hm(e.e) != null ? hm(e.e) : (hm(e.s) != null ? hm(e.s) + 60 : null); }).filter(function (x) { return x != null; });
    var from = Math.min(9 * 60, st.length ? Math.min.apply(null, st) - 30 : 9 * 60), to = Math.max(19 * 60, en.length ? Math.max.apply(null, en) + 30 : 19 * 60);
    return [Math.max(6 * 60, from), Math.min(24 * 60 - 1, to)];
  }
  function hoursIn(w) { return (S.hours || []).filter(function (h) { return h.h * 60 >= w[0] - 59 && h.h * 60 <= w[1]; }); }
  function dayCond() {
    var hs = hoursIn(dayWindow());
    if (!hs.length) return cond();
    var feels = hs.map(function (h) { return h.feels; }), p = Math.max.apply(null, hs.map(function (h) { return h.p; }));
    var rain = hs.some(function (h) { return RAIN.indexOf(h.code) >= 0; }) || p >= 50;
    var lo = Math.min.apply(null, feels), hi = Math.max.apply(null, feels);
    return { t: Math.round(lo * 0.6 + hi * 0.4), lo: lo, hi: hi, rain: rain, p: p, hs: hs };
  }
  function dayPicks() {
    var c = dayCond(), tg2 = tagsOf(DAY.ev), want = tg2.evening && !tg2.office ? "evening" : tg2.office ? "office" : null;
    var ranked = D.looks.slice().sort(function (a, b) {
      var sa = score(a, c) - (want && a.dir === want ? 3 : 0), sb = score(b, c) - (want && b.dir === want ? 3 : 0);
      return sa - sb || a.id - b.id;
    });
    var pool = ranked.slice(0, 9), k = (S.skip * 3) % pool.length, out = [];
    for (var i = 0; i < 3; i++) out.push(pool[(k + i) % pool.length]);
    return { looks: out, c: c, want: want, tags: tg2 };
  }
  function dayAdvice(c, tags) {
    var r = [];
    if (c.hs && c.hi - c.lo >= 5) {
      var cold = c.hs.reduce(function (a, b) { return b.feels < a.feels ? b : a; }), warm = c.hs.reduce(function (a, b) { return b.feels > a.feels ? b : a; });
      r.push("Ощущается от " + sgn(c.lo) + "° (" + pad(cold.h) + ":00) до " + sgn(c.hi) + "° (" + pad(warm.h) + ":00) — оденьтесь слоями, чтобы верхний можно было снять.");
    }
    if (tags.evening && c.hs) {
      var ev = tags.evening[0], eh = Math.floor((hm(ev.s) || 19 * 60) / 60), late = c.hs.filter(function (h) { return h.h >= eh; });
      if (late.length && Math.min.apply(null, late.map(function (h) { return h.feels; })) <= c.hi - 3)
        r.push("К «" + ev.t + "» похолодает до " + sgn(Math.min.apply(null, late.map(function (h) { return h.feels; }))) + "° — лучше тёплый верхний слой, а не лёгкий.");
    }
    if (tags.office && tags.evening) r.push("День из офиса в вечер: базовый образ + акцент на вечер (украшение, помада, сменить обувь).");
    if (tags.sport) r.push("Есть тренировка — удобная обувь и сумка, куда поместится форма.");
    return r;
  }
  var TAKE = {
    umbrella: "Зонт", scarf: "Шарф и перчатки", hat: "Шапка", shoes2: "Сменная обувь на вечер", sportkit: "Спортивная форма и кроссовки",
    docs: "Паспорт, полис, документы", charge: "Зарядка и наушники", sun: "Солнцезащитные очки", water: "Вода и перекус"
  };
  function takeList(c, tags) {
    var r = [], rainH = (c.hs || []).filter(function (h) { return h.p >= 40 || RAIN.indexOf(h.code) >= 0; });
    if (rainH.length || c.rain) r.push(["umbrella", rainH.length ? "дождь около " + pad(rainH[0].h) + ":00 (" + Math.max.apply(null, rainH.map(function (h) { return h.p; })) + "%)" : "возможен дождь"]);
    if (c.lo <= 2 || c.t <= 2) r.push(["scarf", "ощущается до " + sgn(c.lo != null ? c.lo : c.t) + "°"]);
    if ((c.lo != null ? c.lo : c.t) <= -5) r.push(["hat", ""]);
    if (tags.evening && (c.rain || (c.lo != null && c.lo <= 0))) r.push(["shoes2", "слякоть днём, а вечером — " + tags.evening[0].t]);
    if (tags.sport) r.push(["sportkit", tags.sport[0].t]);
    if (tags.docs) r.push(["docs", tags.docs[0].t]);
    if (tags.travel) r.push(["charge", tags.travel[0].t]);
    if ((c.hs || []).some(function (h) { return h.code === 0 && h.h >= 11 && h.h <= 16; }) && c.hi >= 10) r.push(["sun", "солнечно днём"]);
    var w = dayWindow(); if (w[1] - w[0] >= 10 * 60) r.push(["water", "длинный день, до " + fmtH(w[1])]);
    return r;
  }

  /* ---------- «Мой день» screen ---------- */
  var WXI = function (code) { return code === 0 ? "☀︎" : code <= 3 ? "⛅︎" : code <= 48 ? "≋" : RAIN.indexOf(code) >= 0 ? (code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82 ? "❄︎" : "☂︎") : "☁︎"; };
  function viewDay() {
    if (!DAY.loaded || DAY.key !== todayKey()) { loadDay(render); return lt("", "Сегодня") + '<div class="empty">Загружаю день…</div>'; }
    var date = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
    var P = dayPicks(), c = P.c, w = S.wx, h = P.looks[0], cx = ctxList("today", P.looks.map(function (l) { return l.key; }));
    var now = new Date().getHours(), win = dayWindow();
    var hours = (S.hours || []).filter(function (x) { return x.h >= Math.min(now, Math.floor(win[0] / 60)) && x.h <= 23; });
    var wx = w ? '<div class="wx"><div class="deg">' + sgn(w.t) + '°</div><div class="info"><span class="cond' + (w.rain ? " rain" : "") + '">' + wxText(w.code) + "</span>" +
        '<span class="foot">Ощущается ' + sgn(w.feels) + "°, днём " + sgn(w.min) + "…" + sgn(w.max) + "°</span><span class=\"foot\">Ветер " + w.wind + " км/ч · осадки до " + w.p + "%</span></div></div>" +
        (hours.length ? '<div class="hours">' + hours.map(function (x) { return '<div class="hr' + (x.h === now ? " now" : "") + (x.h * 60 >= win[0] - 59 && x.h * 60 <= win[1] ? " out" : "") + '"><span class="hh">' + (x.h === now ? "Сейчас" : pad(x.h)) + '</span><span class="ic">' + WXI(x.code) + "</span>" + (x.p >= 30 ? '<span class="pp">' + x.p + "%</span>" : '<span class="pp"></span>') + '<span class="tt">' + sgn(x.t) + "°</span></div>"; }).join("") + "</div>" : "")
      : '<div class="wx"><div class="deg">' + sgn(c.t) + '°</div><div class="info"><span class="cond">Прогноз не загрузился</span><div class="ctl"><span class="stepper"><button type="button" data-act="t-" aria-label="Холоднее">−</button><span>' + sgn(c.t) + '°</span><button type="button" data-act="t+" aria-label="Теплее">+</button></span><button type="button" class="chip" data-act="rain" aria-pressed="' + c.rain + '">Дождь</button><button type="button" class="chip" data-act="reload">Обновить</button></div></div></div>';
    var evs = DAY.ev.length ? '<div class="group">' + DAY.ev.map(function (e, i) {
      return '<div class="row ev"><span class="tm t">' + (e.s ? esc(e.s) + (e.e ? '<small>' + esc(e.e) + "</small>" : "") : "весь<br>день") + '</span><span class="grow"><span>' + esc(e.t) + "</span>" + (e.loc ? '<span class="small">' + esc(e.loc) + "</span>" : "") + '</span><button type="button" class="x" data-delev="' + i + '" aria-label="Удалить событие">×</button></div>';
    }).join("") + "</div>" : '<div class="empty">Событий нет. Подтяните их из календаря или добавьте вручную.</div>';
    var adv = dayAdvice(c, P.tags), take = takeList(c, P.tags);
    var note = (P.want === "evening" ? "Под вечерние планы" : P.want === "office" ? "Под рабочий день" : "Для " + h.temp + "°") + (c.rain && hasItem(h, function (x) { return x.rain; }) ? " · мартинсы на случай луж" : "");
    var tasksHtml = '<div class="group">' + DAY.tasks.map(function (t, i) {
      return '<div class="row chk"><button type="button" class="cb" data-task="' + i + '" aria-pressed="' + !!t.d + '" aria-label="Готово"></button><span class="grow' + (t.d ? " done" : "") + '">' + esc(t.t) + '</span><button type="button" class="x" data-deltask="' + i + '" aria-label="Удалить">×</button></div>';
    }).join("") + '<form class="row" id="taskf"><span class="cb add">+</span><input id="newtask" class="field" placeholder="Новое дело" autocomplete="off" enterkeyhint="done"></form></div>';
    return lt(date, "Мой день", esc(S.city.name)) +
      sec("", wx) +
      sec("Планы", evs + '<div class="pair"><button type="button" class="btn tint sm2" data-act="calpaste">Из календаря</button><button type="button" class="btn gray sm2" data-act="addev">Добавить</button></div>' +
        '<button type="button" class="link center" data-act="calhelp">Как подтягивать календарь автоматически</button>', DAY.ev.length ? String(DAY.ev.length) : "") +
      sec("Образ на день", card(h, cx, { hero: true, note: note }) + (adv.length ? '<div class="group">' + adv.map(function (a) { return '<div class="row"><span class="ico">' + IC.spark + '</span><span class="grow">' + esc(a) + "</span></div>"; }).join("") + "</div>" : "") +
        '<div class="duo">' + card(P.looks[1], cx) + card(P.looks[2], cx) + "</div>" +
        '<div class="pair"><button type="button" class="btn gray" data-act="more">Другие</button><button type="button" class="btn tint" data-act="gen">' + IC.spark + "Новый</button></div>") +
      (take.length ? sec("Взять с собой", '<div class="group">' + take.map(function (t) {
        var on = !!DAY.chk[t[0]];
        return '<div class="row chk"><button type="button" class="cb" data-take="' + t[0] + '" aria-pressed="' + on + '" aria-label="Взяла"></button><span class="grow' + (on ? " done" : "") + '"><span>' + TAKE[t[0]] + "</span>" + (t[1] ? '<span class="small">' + esc(t[1]) + "</span>" : "") + "</span></div>";
      }).join("") + "</div>") : "") +
      sec("Дела", tasksHtml, DAY.tasks.length ? DAY.tasks.filter(function (t) { return t.d; }).length + " из " + DAY.tasks.length : "") +
      sec("Заметка", '<div class="group"><div class="row"><textarea id="daynote" class="field" rows="3" placeholder="Что важно не забыть сегодня">' + esc(DAY.note) + "</textarea></div></div>") +
      sec("Помощник", '<div class="group">' +
        '<button type="button" class="row" data-act="trips"><span class="ico">' + IC.suitcase + '</span><span class="grow"><span>Чемодан на поездку</span><span class="small">Образы по прогнозу и список вещей</span></span><span class="chev">›</span></button>' +
        '<button type="button" class="row" data-act="gaps"><span class="ico">' + IC.gaps + '</span><span class="grow"><span>Пробелы в гардеробе</span><span class="small">Чего не хватает под погоду и образы</span></span><span class="chev">›</span></button>' +
        '<button type="button" class="row" data-act="buycheck"><span class="ico">' + IC.tag + '</span><span class="grow"><span>Проверить покупку</span><span class="small">С чем носить и сколько образов даст</span></span><span class="chev">›</span></button>' +
        '<button type="button" class="row" data-act="chat"><span class="ico">' + IC.chat + '</span><span class="grow"><span>Спросить ассистента</span><span class="small">ИИ знает ваш гардероб, погоду и планы</span></span><span class="chev">›</span></button></div>');
  }

  /* ---------- sheets: add event, calendar help ---------- */
  function addEvSheet() {
    return function () {
      return { nav: nav("Новое событие"), body:
        sec("", '<form id="evf" class="group"><div class="row"><span class="grow small">Начало</span><input id="evs" class="field tr" type="time" value="' + pad((new Date().getHours() + 1) % 24) + ':00"></div>' +
          '<div class="row"><span class="grow small">Конец</span><input id="eve" class="field tr" type="time"></div>' +
          '<div class="row"><input id="evt" class="field" placeholder="Что: встреча, ужин, йога…" required></div>' +
          '<div class="row"><input id="evl" class="field" placeholder="Где (необязательно)"></div></form>' +
          '<button type="submit" form="evf" class="btn fill">Добавить</button>') };
    };
  }
  function calHelpSheet() {
    return function () {
      var base = location.origin + location.pathname;
      var steps = [
        "Откройте «Команды» → «+» → назовите «Капсула: день».",
        "Действие «Найти события календаря»: фильтр «Дата начала — сегодня», сортировка по дате начала.",
        "«Повторить с каждым» → внутри «Текст»: Время начала (формат ЧЧ:мм) | Время окончания (ЧЧ:мм) | Название | Место.",
        "После повтора — «Объединить текст» (разделитель — новая строка), затем «Скопировать в буфер».",
        "Дальше «Открыть URL»: " + base + "#day= и в конец — переменная «Объединённый текст» (если открываете «Капсулу» в Safari или Telegram). Если «Капсула» на экране «Домой» — этот шаг не нужен: откройте приложение и нажмите «Вставить из календаря».",
        "«Автоматизация» → «Время суток» 7:30 → «Капсула: день» → «Запускать сразу»."
      ];
      return { nav: nav("Календарь"), body:
        sec("Как это работает", '<p class="foot pad">Приложение не может само читать календарь iPhone. Команда в «Командах» берёт сегодняшние события и передаёт их в «Капсулу» — прямо на телефоне, никуда не отправляя.</p>') +
        sec("Настройка, один раз", howList(steps)) +
        sec("Формат", '<p class="foot pad">Подойдёт и обычный текст — по строке на событие: «09:30–10:30 Встреча с клиентом». Его можно вставить из любого места.</p>') };
    };
  }

  /* ---------- trips ---------- */
  function tripsSheet() {
    return function () {
      var list = TRIPS.length ? '<div class="group">' + TRIPS.map(function (t, i) {
        return '<button type="button" class="row" data-trip="' + i + '"><span class="ico">' + IC.suitcase + '</span><span class="grow"><span>' + esc(t.city) + '</span><span class="small">' + esc(fmtRange(t.from, t.to)) + " · " + t.days.length + " " + plural(t.days.length, "день", "дня", "дней") + '</span></span><span class="chev">›</span></button>';
      }).join("") + "</div>" : "";
      return { nav: nav("Чемодан"), body:
        (list ? sec("Мои поездки", list) : "") +
        sec("Новая поездка", '<form id="tripf" class="group"><div class="row"><input id="tcity" class="field" placeholder="Город, например Москва" required autocomplete="off"></div>' +
          '<div class="row"><span class="grow small">Туда</span><input id="tfrom" class="field tr" type="date" required value="' + todayKey(new Date(Date.now() + 864e5)) + '"></div>' +
          '<div class="row"><span class="grow small">Обратно</span><input id="tto" class="field tr" type="date" required value="' + todayKey(new Date(Date.now() + 3 * 864e5)) + '"></div></form>' +
          '<p class="foot err pad" id="terr" hidden></p><button type="submit" form="tripf" class="btn fill" id="tbtn">Собрать чемодан</button>' +
          '<p class="foot pad">Возьму прогноз на эти дни (а если поездка дальше чем через 2 недели — погоду прошлого года), подберу образы на каждый день так, чтобы вещи повторялись, и составлю список.</p>') };
    };
  }
  function fmtRange(a, b) { var o = { day: "numeric", month: "short" }; return new Date(a + "T12:00").toLocaleDateString("ru-RU", o) + " — " + new Date(b + "T12:00").toLocaleDateString("ru-RU", o); }
  function jget(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error("http"); return r.json(); }); }
  function buildTrip(city, from, to) {
    var d0 = new Date(from + "T12:00"), d1 = new Date(to + "T12:00"), n = Math.round((d1 - d0) / 864e5) + 1;
    if (!(n >= 1)) return Promise.reject(new Error("Проверьте даты"));
    if (n > 14) return Promise.reject(new Error("Не больше 14 дней"));
    return jget("https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&name=" + encodeURIComponent(city)).then(function (g) {
      var p = g.results && g.results[0]; if (!p) throw new Error("Не нашла такой город");
      var ahead = (d1 - new Date()) / 864e5 < 15, q = "&daily=apparent_temperature_min,apparent_temperature_max,precipitation_probability_max,precipitation_sum,weather_code&timezone=auto";
      var u = ahead ? "https://api.open-meteo.com/v1/forecast?latitude=" + p.latitude + "&longitude=" + p.longitude + q + "&start_date=" + from + "&end_date=" + to
        : "https://archive-api.open-meteo.com/v1/archive?latitude=" + p.latitude + "&longitude=" + p.longitude + q.replace(",precipitation_probability_max", "") + "&start_date=" + shiftYear(from) + "&end_date=" + shiftYear(to);
      return jget(u).then(function (w) {
        var dd = w.daily, days = [], chosen = {};
        for (var i = 0; i < n; i++) {
          var lo = Math.round(dd.apparent_temperature_min[i]), hi = Math.round(dd.apparent_temperature_max[i]);
          var pr = dd.precipitation_probability_max ? dd.precipitation_probability_max[i] : (dd.precipitation_sum[i] > 1 ? 70 : 10);
          var c = { t: Math.round(lo * 0.6 + hi * 0.4), rain: pr >= 50 || RAIN.indexOf(dd.weather_code[i]) >= 0 };
          var best = null, bs = 1e9;
          for (var k = 0; k < 40; k++) {
            var b = generate(c); if (!b) continue;
            var ids = buildItems(b), fresh = ids.filter(function (id) { return !chosen[id]; }).length;
            var outerNew = b.outer && Object.keys(chosen).length && !chosen[b.outer] ? 4 : 0;
            var sc = fresh * 2 + outerNew + rnd();
            if (sc < bs) { bs = sc; best = b; }
          }
          if (best) buildItems(best).forEach(function (id) { chosen[id] = 1; });
          days.push({ date: todayKey(new Date(d0.getTime() + i * 864e5)), lo: lo, hi: hi, p: pr, code: dd.weather_code[i], b: best || {} });
        }
        return { city: p.name + (p.country && p.country !== "Россия" ? ", " + p.country : ""), from: from, to: to, approx: !ahead, days: days, packed: {} };
      });
    });
  }
  function shiftYear(d) { return (+d.slice(0, 4) - 1) + d.slice(4); }
  function tripItems(t) { var m = {}; t.days.forEach(function (d) { buildItems(d.b).forEach(function (id) { m[id] = (m[id] || 0) + 1; }); }); return m; }
  function tripSheet(i) {
    return function () {
      var t = TRIPS[i]; if (!t) return { nav: nav(""), body: "" }; cur.trip = i;
      var items = tripItems(t), wear = t.days[0] && t.days[0].b, n = t.days.length;
      var rain = t.days.some(function (d) { return d.p >= 50; }), cold = Math.min.apply(null, t.days.map(function (d) { return d.lo; }));
      var basics = ["Нижнее бельё × " + (n + 1), "Носки или колготки × " + (n + 1), "Пижама", "Косметичка и уход", "Зарядка, наушники", "Документы, билеты, карты"]
        .concat(rain ? ["Зонт"] : []).concat(cold <= 0 ? ["Шапка, шарф, перчатки"] : []).concat(n >= 5 ? ["Мешок для грязного"] : []);
      var cats = {}; Object.keys(items).forEach(function (id) { var x = ITEM[id]; if (!x) return; var onMe = wear && (wear.outer === id || wear.shoes === id); (cats[onMe ? "На себе в дорогу" : CATS[x.cat] || "Другое"] = cats[onMe ? "На себе в дорогу" : CATS[x.cat] || "Другое"] || []).push(x); });
      var pack = Object.keys(cats).map(function (c) {
        return sec(c, '<div class="group">' + cats[c].map(function (x) {
          var on = !!t.packed[x.id];
          return '<div class="row chk th"><button type="button" class="cb" data-pack="' + x.id + '" aria-pressed="' + on + '" aria-label="Положила"></button><span class="thumb' + (x.photo || x.card ? " card" : "") + '">' + itemImg(x) + '</span><span class="grow' + (on ? " done" : "") + '"><span>' + esc(x.name) + '</span><span class="small">' + items[x.id] + " " + plural(items[x.id], "день", "дня", "дней") + "</span></span></div>";
        }).join("") + "</div>");
      }).join("");
      var days = t.days.map(function (d, j) {
        var dt = new Date(d.date + "T12:00").toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" });
        return '<div class="tday"><img data-tripboard="' + i + ":" + j + '" alt=""><div class="meta"><span class="name">' + esc(dt) + '</span><span class="note">' + sgn(d.lo) + "…" + sgn(d.hi) + "°" + (d.p >= 50 ? " · ☂︎ " + d.p + "%" : "") + "</span></div></div>";
      }).join("");
      return { nav: nav(t.city, '<button type="button" class="act" data-deltrip="' + i + '" aria-label="Удалить поездку">' + IC.trash + "</button>"), body:
        '<section class="sec titleblock"><h2 class="title">' + esc(t.city) + '</h2><div class="badges"><span class="badge">' + esc(fmtRange(t.from, t.to)) + '</span><span class="badge">' + Object.keys(items).length + " вещей</span>" + (t.approx ? '<span class="badge">по погоде прошлого года</span>' : "") + "</div></section>" +
        sec("Образы по дням", '<div class="tdays">' + days + "</div>") + pack +
        sec("Не забыть", '<div class="group">' + basics.map(function (b) { var k = "b:" + b, on = !!t.packed[k]; return '<div class="row chk"><button type="button" class="cb" data-pack="' + esc(k) + '" aria-pressed="' + on + '"></button><span class="grow' + (on ? " done" : "") + '">' + esc(b) + "</span></div>"; }).join("") + "</div>") };
    };
  }

  /* ---------- gaps in the wardrobe ---------- */
  function gapsSheet() {
    return function () {
      var all = allItems().filter(function (x) { return !x.off; }), by = function (f) { return all.filter(f); };
      var out = [], ok = [];
      var outers = by(function (x) { return x.sub === "outer"; });
      [[-25, -10, "сильный мороз (−10° и ниже)"], [-10, 0, "холод (−10…0°)"], [0, 10, "межсезонье (0…+10°)"], [10, 20, "тепло (+10…+20°)"]].forEach(function (r) {
        var n = outers.filter(function (x) { return x.tr && x.tr[0] <= r[1] && x.tr[1] >= r[0]; }).length;
        (n ? ok : out).push(n ? "Верхняя одежда на " + r[2] + ": " + n : "Нет верхней одежды на " + r[2] + ".");
      });
      var shoes = by(function (x) { return x.sub === "shoes"; }), warmSh = shoes.filter(function (x) { return x.rain; });
      if (warmSh.length < 2) out.push("На слякоть подходит только " + (warmSh[0] ? warmSh[0].name : "одна пара") + ". Вторая непромокаемая пара (ботинки, челси) разгрузит её — и пригодится зимой, если с утеплением.");
      var tops = by(function (x) { return x.cat === "top"; }), bottoms = by(function (x) { return x.cat === "bottom"; });
      var neutral = /черн|сер|беж|молоч|бел|темно|графит|шоколад|коричн|деним|джинс/i;
      var nb = bottoms.filter(function (x) { return neutral.test(x.name); }).length;
      ok.push("Верх: " + tops.length + ", низ: " + bottoms.length + " (нейтральных низов " + nb + ").");
      if (tops.length / Math.max(1, bottoms.length) > 4) out.push("Верха в " + Math.round(tops.length / bottoms.length) + " раз больше, чем низов — ещё одни нейтральные брюки или юбка дадут десятки новых сочетаний.");
      var warm = by(function (x) { return x.sub === "warm"; }).length; if (warm < 5) out.push("Тёплых свитеров и свитшотов всего " + warm + " — на зиму в Петербурге маловато, особенно тонких под пиджак.");
      if (by(function (x) { return x.sub === "skirt" || x.sub === "dress"; }).length < 3) out.push("Юбок и платьев почти нет — для вечерних планов и офиса пригодится одна универсальная миди.");
      var unused = by(function (x) { return !x.photo && !usage(x.id).length; });
      var offs = allItems().filter(function (x) { return x.off; });
      return { nav: nav("Пробелы"), body:
        sec("Чего не хватает", out.length ? '<div class="group">' + out.map(function (s) { return '<div class="row"><span class="ico warn">!</span><span class="grow">' + esc(s) + "</span></div>"; }).join("") + "</div>" : '<div class="empty">Явных пробелов не вижу.</div>') +
        sec("Что уже хорошо", '<div class="group">' + ok.map(function (s) { return '<div class="row"><span class="ico okc">✓</span><span class="grow">' + esc(s) + "</span></div>"; }).join("") + "</div>") +
        (unused.length ? sec("Пока ни в одном образе", '<div class="strip">' + unused.slice(0, 20).map(function (x) { return tile(x); }).join("") + "</div>", String(unused.length)) : "") +
        (offs.length ? sec("Не подходят", '<div class="group">' + offs.map(function (x) { return '<div class="row"><span class="grow"><span>' + esc(x.name) + '</span><span class="small">' + esc(x.off) + " — продать или отдать?</span></span></div>"; }).join("") + "</div>") : "") +
        sec("", '<button type="button" class="btn tint" data-ask="Посмотри на мой гардероб: каких 3–5 вещей мне не хватает на осень и зиму в Петербурге, чтобы появилось больше образов? Объясни коротко, почему каждая.">' + IC.chat + "Обсудить с ассистентом</button>") };
    };
  }

  /* ---------- check a purchase before buying ---------- */
  var BUY = { photo: null, name: "", cat: "base", res: null };
  function forcedLooks(x) {
    var keep = S.seed, seen = {}, looks = [];
    [2, 8, 14].forEach(function (t) {
      for (var k = 0; k < 40; k++) {
        var b = generate({ t: t, rain: false }, x); if (!b) continue;
        var key = buildItems(b).sort().join(","); if (seen[key]) continue;
        seen[key] = 1; if (looks.length < 6) looks.push(b);
      }
    });
    S.seed = keep;
    return { n: Object.keys(seen).length, looks: looks };
  }
  function buySheet() {
    return function () {
      var r = BUY.res;
      return { nav: nav("Проверить покупку"), body:
        sec("", '<label class="drop upl">' + (BUY.photo ? '<img src="' + BUY.photo + '" alt="">' : "Сфотографировать вещь в магазине") + '<input type="file" accept="image/*" id="buyphoto"></label>') +
        sec("Что это", '<div class="group"><div class="row"><input id="buyname" class="field" placeholder="Например, свитер серый объёмный" value="' + esc(BUY.name) + '"></div></div>' +
          '<div class="chips wrapx">' + ADDCATS.map(function (c) { return '<button type="button" class="chip" data-buycat="' + c[0] + '" aria-pressed="' + (BUY.cat === c[0]) + '">' + c[1] + "</button>"; }).join("") + "</div>") +
        sec("", '<button type="button" class="btn fill" data-act="buyrun">Проверить</button>') +
        (r ? sec("Результат", '<div class="group"><div class="row"><span class="grow"><span class="big">≈ ' + r.n + " " + plural(r.n, "образ", "образа", "образов") + '</span><span class="small">столько разных сочетаний собирается с вашими вещами</span></span></div>' +
            (r.similar.length ? '<div class="row"><span class="grow"><span>Похожее у вас уже есть</span><span class="small">' + esc(r.similar.map(function (x) { return x.name; }).join(", ")) + "</span></span></div>" : "") +
            '<div class="row"><span class="grow small">' + esc(r.verdict) + "</span></div></div>" +
            '<div class="tdays">' + r.looks.map(function (b, j) { return '<div class="tday"><img data-buyboard="' + j + '" alt=""></div>'; }).join("") + "</div>" +
            '<button type="button" class="btn tint" data-act="buyask">' + IC.chat + "Спросить ассистента" + (BUY.photo ? " по фото" : "") + "</button>") : "") };
    };
  }
  function runBuy() {
    var c = ADDCATS.filter(function (z) { return z[0] === BUY.cat; })[0], nm = BUY.name || c[1];
    var x = { id: "_buy", name: nm, cat: c[2], sub: c[0], photo: true, acc: false, summer: false, off: "", rare: false, rain: /ботин|сапог|челси|резин/i.test(nm), suede: /замш/i.test(nm), peplum: false, crop: /укороч|кроп/i.test(nm), tr: c[0] === "outer" ? [-10, 12] : null };
    ITEM._buy = x; photos.item__buy = BUY.photo;
    var f = forcedLooks(x), words = nm.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 3; });
    var similar = allItems().filter(function (y) { return y.sub === x.sub && words.some(function (w) { return y.name.toLowerCase().indexOf(w.slice(0, 5)) >= 0; }); }).slice(0, 4);
    var verdict = f.n >= 25 ? "Хорошо встраивается: сочетается с большой частью гардероба." : f.n >= 10 ? "Встраивается неплохо, но не «со всем подряд»." : "Сочетаний мало — подумайте, с чем именно вы будете это носить.";
    if (similar.length >= 2) verdict += " Но похожих вещей уже " + similar.length + ".";
    BUY.res = { n: f.n, looks: f.looks, similar: similar, verdict: verdict };
  }

  /* ---------- AI assistant (OpenAI-compatible: DeepSeek or AITUNNEL) ---------- */
  var PROV = {
    deepseek: { name: "DeepSeek", base: "https://api.deepseek.com", model: "deepseek-v4-flash", keyUrl: "https://platform.deepseek.com/api_keys" },
    aitunnel: { name: "AITUNNEL (российская карта)", base: "https://api.aitunnel.ru/v1", model: "deepseek-v4.1-flash", keyUrl: "https://aitunnel.ru/" },
    custom: { name: "Другой (совместимый с OpenAI)", base: "", model: "" }
  };
  function aiConf() { try { return JSON.parse(localStorage.getItem("kap_ai") || "null") || {}; } catch (e) { return {}; } }
  function aiSave(c) { try { localStorage.setItem("kap_ai", JSON.stringify(c)); } catch (e) {} }
  var CHAT = { msgs: [], busy: false, loaded: false, draft: "", pendingImg: null };
  function chatLoad() { if (CHAT.loaded) return; CHAT.loaded = true; try { CHAT.msgs = JSON.parse(localStorage.getItem("kap_chat") || "[]"); } catch (e) { CHAT.msgs = []; } }
  function chatSave() { try { localStorage.setItem("kap_chat", JSON.stringify(CHAT.msgs.slice(-40).map(function (m) { return { r: m.r, t: m.t }; }))); } catch (e) {} }
  function systemPrompt() {
    var c = dayCond(), P = DAY.loaded ? dayPicks() : null;
    var items = allItems().map(function (x) { return x.id + ": " + x.name + " [" + (CATS[x.cat] || x.cat) + (x.off ? ", не подходит: " + x.off : "") + (x.rare ? ", ношу редко" : "") + "]"; }).join("\n");
    var w = S.wx ? "Сейчас " + sgn(S.wx.t) + "°, ощущается " + sgn(S.wx.feels) + "°, " + wxText(S.wx.code).toLowerCase() + ", днём " + sgn(S.wx.min) + "…" + sgn(S.wx.max) + "°, осадки до " + S.wx.p + "%." : "Погода неизвестна, ориентир " + sgn(c.t) + "°.";
    var hrs = (S.hours || []).filter(function (h) { return h.h >= 7 && h.h % 2 === 0; }).map(function (h) { return pad(h.h) + ":00 " + sgn(h.feels) + "° " + (h.p >= 30 ? h.p + "%" : ""); }).join("; ");
    var PR = D.profile || {};
    return "Ты — личный стилист и помощник" + (PR.name ? " " + PR.name : "") + ". Отвечай по-русски, коротко и по делу, дружелюбно, без воды. Форматирование: короткие абзацы и списки через «- ».\n" + (PR.about ? "О ней: " + PR.about + "\n" : "") +
      "Правила стилизации: у серых и чёрных брюк баска сбоку — её завязывают выше или ниже; мартинсы — обувь на дождь; замшу в дождь не носить; укороченный верх — с майкой под низ.\n" +
      "Сегодня " + new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" }) + ". " + w + (hrs ? " По часам: " + hrs + "." : "") + "\n" +
      (DAY.ev.length ? "Планы на сегодня: " + DAY.ev.map(function (e) { return (e.s ? e.s + (e.e ? "–" + e.e : "") + " " : "") + e.t + (e.loc ? " (" + e.loc + ")" : ""); }).join("; ") + ".\n" : "Планов в календаре на сегодня нет.\n") +
      (DAY.tasks.length ? "Дела: " + DAY.tasks.map(function (t) { return (t.d ? "[готово] " : "") + t.t; }).join("; ") + ".\n" : "") +
      (P ? "Приложение предлагает на сегодня образ «" + P.looks[0].title + "»: " + P.looks[0].items.map(function (id) { return ITEM[id] ? ITEM[id].name : id; }).join(", ") + ".\n" : "") +
      "Её гардероб (id: название [категория]):\n" + items + "\n" +
      "Когда советуешь вещи из гардероба, ставь после названия её id в двойных квадратных скобках, например «Тренч черный [[i05]]» — приложение покажет миниатюру. Предлагай только вещи из этого списка, если не просят идей для покупки.";
  }
  function chatHtml() {
    var conf = aiConf();
    var msgs = CHAT.msgs.map(function (m, i) {
      return '<div class="msg ' + (m.r === "user" ? "me" : "ai") + '">' + (m.img ? '<img src="' + m.img + '" alt="">' : "") + '<div class="bub">' + (m.r === "user" ? esc(m.t).replace(/\n/g, "<br>") : md(m.t)) + (m.r !== "user" && !m.t && CHAT.busy && i === CHAT.msgs.length - 1 ? '<span class="dots3"><i></i><i></i><i></i></span>' : "") + "</div>" + (m.r !== "user" && m.t ? outfitBtn(m.t) : "") + "</div>";
    }).join("");
    var hello = !CHAT.msgs.length ? '<div class="hello"><div class="logo sm">' + IC.chat + '</div><p class="foot">Спросите про образ на сегодня, что надеть на конкретное событие, с чем носить вещь или что купить.</p><div class="chips wrapx center">' +
      ["Что надеть сегодня с учётом планов?", "Собери образ на свидание из моих вещей", "С чем носить тренч кроме джинсов?", "Чего мне не хватает на зиму?"].map(function (q) { return '<button type="button" class="chip" data-ask="' + esc(q) + '">' + esc(q) + "</button>"; }).join("") + "</div></div>" : "";
    var need = !_aiConf().key ? '<div class="empty">Чтобы ассистент заработал, добавьте ключ API. <button type="button" class="link" data-act="aiset">Настроить</button></div>' : "";
    return '<div class="chat" id="chatlist">' + hello + need + msgs + "</div>" +
      '<form class="composer" id="chatf">' + (CHAT.pendingImg ? '<div class="att"><img src="' + CHAT.pendingImg + '" alt=""><button type="button" data-act="unatt" aria-label="Убрать фото">×</button></div>' : "") +
      '<label class="attach upl" aria-label="Приложить фото">' + IC.camera + '<input type="file" accept="image/*" id="chatimg"></label>' +
      '<textarea id="chatin" rows="1" placeholder="Сообщение" enterkeyhint="send">' + esc(CHAT.draft) + '</textarea><button type="submit" class="send" aria-label="Отправить"' + (CHAT.busy ? " disabled" : "") + ">" + IC.send + "</button></form>";
  }
  function md(t) {
    var h = esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[\[(i\d+|u[a-z0-9]+)\]\]/g, function (m, id) {
      var x = ITEM[id]; return x ? '<button type="button" class="ichip" data-item="' + id + '"><span class="thumb' + (x.photo || x.card ? " card" : "") + '">' + itemImg(x) + "</span></button>" : "";
    });
    return h.split(/\n{2,}/).map(function (p) {
      var lines = p.split("\n");
      if (lines.every(function (l) { return /^\s*([-•*]|\d+[.)])\s+/.test(l); })) return "<ul>" + lines.map(function (l) { return "<li>" + l.replace(/^\s*([-•*]|\d+[.)])\s+/, "") + "</li>"; }).join("") + "</ul>";
      return "<p>" + lines.join("<br>") + "</p>";
    }).join("");
  }
  function idsIn(t) { var m = {}, r = /\[\[(i\d+|u[a-z0-9]+)\]\]/g, x; while ((x = r.exec(t))) if (ITEM[x[1]]) m[x[1]] = 1; return Object.keys(m); }
  function outfitBtn(t) { var ids = idsIn(t); return ids.length >= 3 ? '<button type="button" class="link" data-tobuild="' + ids.join(",") + '">Открыть в «Собрать»</button>' : ""; }
  function chatSheet() {
    return function () {
      chatLoad();
      return { nav: nav("Ассистент", '<button type="button" class="act" data-act="aiset" aria-label="Настройки ассистента">' + IC.gear + "</button>"), body: chatHtml(), cls: "chatsheet" };
    };
  }
  function redrawChat(scroll) {
    var list = $("#chatlist"); if (!list) return;
    var tmp = document.createElement("div"); tmp.innerHTML = chatHtml();
    list.innerHTML = tmp.querySelector("#chatlist").innerHTML;
    var send = document.querySelector("#chatf .send"); if (send) send.disabled = CHAT.busy;
    var att = document.querySelector("#chatf .att"), natt = tmp.querySelector(".att");
    if (att && !natt) att.remove(); else if (!att && natt) $("#chatf").insertBefore(natt, $("#chatf").firstChild);
    if (scroll !== false) { var sh = $(".sheet"); if (sh) sh.scrollTop = sh.scrollHeight; }
  }
  function aiSetSheet() {
    return function () {
      var c = aiConf(), pv = c.prov || "aitunnel", P = PROV[pv];
      return { nav: nav("Ассистент: настройки"), body:
        sec("Через что подключаться", '<div class="group">' + Object.keys(PROV).map(function (k) {
          return '<button type="button" class="row" data-prov="' + k + '"><span class="grow">' + PROV[k].name + "</span>" + (pv === k ? '<span style="color:var(--accent)">✓</span>' : "") + "</button>";
        }).join("") + "</div>" +
          '<p class="foot pad">' + (pv === "aitunnel" ? "Посредник в России: пополнение российской картой от 500 ₽, один вопрос ≈ 0,1–0,2 ₽. Ключ — в личном кабинете aitunnel.ru." : pv === "deepseek" ? "Напрямую: новым аккаунтам 5 млн токенов на 30 дней бесплатно; дальше нужна иностранная карта. Ключ — platform.deepseek.com → API keys." : "Любой сервис с API, совместимым с OpenAI.") + "</p>") +
        sec("Подключение", '<form id="aif" class="group">' +
          (pv === "custom" ? '<div class="row"><input id="aibase" class="field" placeholder="Адрес API, https://…/v1" value="' + esc(c.base || "") + '"></div>' : "") +
          '<div class="row"><input id="aikey" class="field" type="password" placeholder="Ключ API (sk-…)" autocomplete="off" value="' + esc(c.prov === pv ? c.key || "" : "") + '"></div>' +
          '<div class="row"><input id="aimodel" class="field" placeholder="Модель" value="' + esc(c.prov === pv && c.model ? c.model : P.model) + '"><button type="button" class="link" data-act="aimodels">Список</button></div></form>' +
          '<div id="aimlist"></div><p class="foot err pad" id="aierr" hidden></p>' +
          '<button type="submit" form="aif" class="btn fill">Сохранить и проверить</button>' +
          (P.keyUrl ? '<a class="btn gray" href="' + P.keyUrl + '" target="_blank" rel="noopener" data-gemini>Получить ключ</a>' : "") +
          '<p class="foot pad">Ключ хранится только на этом устройстве. В запрос уходят ваш вопрос, погода, планы на день и список вещей (названия) — без фото, кроме тех, что вы прикрепите сами.</p>') +
        (CHAT.msgs.length ? sec("", '<button type="button" class="btn danger" data-act="chatclear">Очистить переписку</button>') : "") };
    };
  }
  function aiBase(c) { return (c.prov === "custom" ? c.base : PROV[c.prov || "aitunnel"].base).replace(/\/+$/, ""); }
  function aiFetchModels(c) {
    return fetch(aiBase(c) + "/models", { headers: { Authorization: "Bearer " + c.key } }).then(function (r) { if (!r.ok) throw new Error(r.status === 401 ? "Ключ не подошёл" : "Ошибка " + r.status); return r.json(); })
      .then(function (j) { return (j.data || []).map(function (m) { return m.id; }); });
  }
  function aiAsk(text, img) {
    var c = _aiConf(); if (!c.key) { aiPick = null; openSheet(aiSetSheet()); return; }
    chatLoad();
    CHAT.msgs.push({ r: "user", t: text, img: img || null }); CHAT.msgs.push({ r: "assistant", t: "" }); CHAT.busy = true; CHAT.draft = ""; CHAT.pendingImg = null;
    redrawChat();
    var hist = CHAT.msgs.slice(-13, -1).map(function (m) {
      if (m.img) return { role: "user", content: [{ type: "text", text: m.t || "Что скажешь про эту вещь?" }, { type: "image_url", image_url: { url: m.img } }] };
      return { role: m.r, content: m.t };
    });
    var out = CHAT.msgs[CHAT.msgs.length - 1], last = 0;
    var body = { model: c.model || PROV[c.prov || "aitunnel"].model, stream: true, temperature: 0.7, messages: [{ role: "system", content: systemPrompt() }].concat(hist) };
    fetch(aiBase(c) + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.key }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { var m = ""; try { m = JSON.parse(t).error.message; } catch (e) { m = t.slice(0, 160); } throw new Error((r.status === 401 ? "Ключ не подошёл. " : r.status === 402 ? "Закончились деньги на балансе. " : "") + m); });
        if (!r.body || !r.body.getReader) return r.json().then(function (j) { out.t = j.choices[0].message.content; });
        var rd = r.body.getReader(), dec = new TextDecoder(), buf = "";
        function step() {
          return rd.read().then(function (x) {
            if (x.done) return;
            buf += dec.decode(x.value, { stream: true });
            var lines = buf.split("\n"); buf = lines.pop();
            lines.forEach(function (l) {
              l = l.trim(); if (l.indexOf("data:") !== 0) return; var d = l.slice(5).trim(); if (d === "[DONE]") return;
              try { var delta = JSON.parse(d).choices[0].delta; if (delta && delta.content) out.t += delta.content; } catch (e) {}
            });
            if (Date.now() - last > 80) { last = Date.now(); redrawChat(); }
            return step();
          });
        }
        return step();
      })
      .catch(function (e) {
        out.t = "⚠︎ " + (e && e.message ? e.message : "Не получилось связаться с ассистентом");
        if (img && /image|vision|multimodal|content/i.test(out.t)) out.t += "\nЭта модель не понимает фото — выберите в настройках модель с поддержкой изображений (например, с «vision» в названии).";
      })
      .then(function () { CHAT.busy = false; if (!out.t) out.t = "…"; chatSave(); redrawChat(); haptic("success"); });
  }

  /* ---------- extra handlers, called from the main listeners ---------- */
  function extraClick(b, d) {
    if (d.delev) { DAY.ev.splice(+d.delev, 1); saveDay(); render(); return true; }
    if (d.task) { var t = DAY.tasks[+d.task]; t.d = !t.d; saveDay(); render(); haptic(); return true; }
    if (d.deltask) { DAY.tasks.splice(+d.deltask, 1); saveDay(); render(); return true; }
    if (d.take) { DAY.chk[d.take] = !DAY.chk[d.take]; saveDay(); render(); haptic(); return true; }
    if (d.trip) { openSheet(tripSheet(+d.trip)); return true; }
    if (d.deltrip) { TRIPS.splice(+d.deltrip, 1); kv.set("trips", TRIPS); closeSheet(); toast("Поездка удалена"); return true; }
    if (d.pack) { var tr = TRIPS[cur.trip]; if (tr) { tr.packed[d.pack] = !tr.packed[d.pack]; kv.set("trips", TRIPS); drawSheet("keep"); haptic(); } return true; }
    if (d.buycat) { BUY.name = ($("#buyname") || {}).value || BUY.name; BUY.cat = d.buycat; BUY.res = null; drawSheet("keep"); return true; }
    if (d.prov) { aiPick = d.prov; drawSheet("keep"); return true; }
    if (d.ask) { var q = d.ask; if (!stack.length || !$(".chatsheet")) openSheet(chatSheet()); aiAsk(q); return true; }
    if (d.tobuild) {
      var nb = {}; d.tobuild.split(",").forEach(function (id) { var x = ITEM[id]; if (!x) return; var sl = SLOTS.filter(function (s) { return s[2].indexOf(x.sub) >= 0; })[0]; if (sl && !nb[sl[0]]) nb[sl[0]] = id; });
      S.build = nb; S.buildTitle = ""; S.tab = "build"; stack = []; drawSheet(); render(); window.scrollTo(0, 0); return true;
    }
    if (d.mpick) { var mi = $("#aimodel"); if (mi) mi.value = d.mpick; $("#aimlist").innerHTML = ""; return true; }
    switch (d.act) {
      case "calpaste":
        if (!navigator.clipboard || !navigator.clipboard.readText) { toast("Вставка недоступна — добавьте событие вручную"); return true; }
        navigator.clipboard.readText().then(function (t) { var ev = parseEvents(t); if (!ev.length) { toast("В буфере нет событий"); return; } DAY.ev = ev; saveDay(); render(); toast("Добавлено событий: " + ev.length); haptic("success"); })
          .catch(function () { toast("Разрешите вставку из буфера"); });
        return true;
      case "addev": openSheet(addEvSheet()); return true;
      case "calhelp": openSheet(calHelpSheet()); return true;
      case "trips": openSheet(tripsSheet()); return true;
      case "gaps": openSheet(gapsSheet()); return true;
      case "buycheck": openSheet(buySheet()); return true;
      case "buyrun": BUY.name = ($("#buyname") || {}).value || ""; runBuy(); drawSheet("keep"); setTimeout(function () { var r = document.querySelector("[data-buyboard]"); if (r) r.scrollIntoView({ block: "center", behavior: "smooth" }); }, 50); return true;
      case "buyask": { var q2 = "Я думаю купить: " + (BUY.name || "вещь на фото") + ". С чем из моего гардероба это носить и стоит ли брать? Учитывай, что похожего у меня уже есть."; openSheet(chatSheet()); aiAsk(q2, BUY.photo); return true; }
      case "chat": openSheet(chatSheet()); setTimeout(function () { var sh = $(".sheet"); if (sh) sh.scrollTop = sh.scrollHeight; }, 30); return true;
      case "aiset": aiPick = null; openSheet(aiSetSheet()); return true;
      case "aimodels": {
        var c1 = aiFormConf(); if (!c1.key) { aiErr("Сначала вставьте ключ"); return true; }
        aiFetchModels(c1).then(function (ms) {
          ms = ms.sort(function (a, b) { return (/deepseek/i.test(b) ? 1 : 0) - (/deepseek/i.test(a) ? 1 : 0); }).slice(0, 30);
          $("#aimlist").innerHTML = '<div class="chips wrapx">' + ms.map(function (m) { return '<button type="button" class="chip" data-mpick="' + esc(m) + '">' + esc(m) + "</button>"; }).join("") + "</div>";
        }).catch(function (e) { aiErr(e.message); });
        return true;
      }
      case "chatclear": CHAT.msgs = []; chatSave(); closeSheet(); toast("Переписка очищена"); return true;
      case "unatt": CHAT.pendingImg = null; redrawChat(false); return true;
    }
    return false;
  }
  var aiPick = null;
  var _aiConf = aiConf;
  aiConf = function () { var c = _aiConf(); if (aiPick) { if (c.prov !== aiPick) { c = { prov: aiPick, key: "", model: "" }; } } return c; };
  function aiFormConf() {
    var pv = aiPick || _aiConf().prov || "aitunnel";
    return { prov: pv, key: (($("#aikey") || {}).value || "").trim(), model: (($("#aimodel") || {}).value || "").trim() || PROV[pv].model, base: (($("#aibase") || {}).value || "").trim() };
  }
  function aiErr(t) { var e = $("#aierr"); if (e) { e.textContent = t; e.hidden = false; } }
  function extraSubmit(e) {
    var f = e.target;
    if (f.id === "taskf") { e.preventDefault(); var v = $("#newtask").value.trim(); if (v) { DAY.tasks.push({ t: v, d: false }); saveDay(); render(); setTimeout(function () { var n = $("#newtask"); if (n) n.focus(); }, 30); } return true; }
    if (f.id === "evf") {
      e.preventDefault(); var t = $("#evt").value.trim(); if (!t) return true;
      DAY.ev.push({ s: $("#evs").value || "", e: $("#eve").value || "", t: t, loc: $("#evl").value.trim() });
      DAY.ev.sort(function (a, b) { return (hm(a.s) || 0) - (hm(b.s) || 0); }); saveDay(); closeSheet(); return true;
    }
    if (f.id === "tripf") {
      e.preventDefault(); var btn = $("#tbtn"); btn.disabled = true; btn.textContent = "Смотрю прогноз…";
      buildTrip($("#tcity").value.trim(), $("#tfrom").value, $("#tto").value).then(function (t) {
        TRIPS.unshift(t); kv.set("trips", TRIPS); stack.pop(); openSheet(tripSheet(0)); haptic("success");
      }).catch(function (er) { btn.disabled = false; btn.textContent = "Собрать чемодан"; var el = $("#terr"); el.textContent = er.message === "http" ? "Нет связи с сервисом погоды" : er.message; el.hidden = false; });
      return true;
    }
    if (f.id === "chatf") {
      e.preventDefault(); if (CHAT.busy) return true; var ta = $("#chatin"), q = ta.value.trim();
      if (!q && !CHAT.pendingImg) return true; aiAsk(q, CHAT.pendingImg); ta.value = ""; return true;
    }
    if (f.id === "aif") {
      e.preventDefault(); var c = aiFormConf();
      if (c.prov === "custom" && !/^https:\/\//.test(c.base)) { aiErr("Нужен адрес API, начинается с https://"); return true; }
      if (!c.key) { aiErr("Вставьте ключ"); return true; }
      aiErr("Проверяю…");
      fetch(aiBase(c) + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.key }, body: JSON.stringify({ model: c.model, max_tokens: 5, messages: [{ role: "user", content: "Ответь одним словом: ок" }] }) })
        .then(function (r) { if (r.ok) return; return r.text().then(function (t) { var m = ""; try { m = JSON.parse(t).error.message; } catch (x) { m = t.slice(0, 160); } throw new Error((r.status === 401 ? "Ключ не подошёл. " : "") + m); }); })
        .then(function () { aiSave({ prov: c.prov, key: c.key, model: c.model, base: c.base }); aiPick = null; toast("Ассистент подключён"); haptic("success"); closeSheet(); })
        .catch(function (er) { aiErr(er.message || "Не получилось подключиться"); });
      return true;
    }
    return false;
  }
  function extraChange(e) {
    var f = e.target.files && e.target.files[0];
    if (e.target.id === "buyphoto" && f) { BUY.name = ($("#buyname") || {}).value || BUY.name; resizeFile(f, 900).then(function (u) { BUY.photo = u; BUY.res = null; drawSheet("keep"); }); return true; }
    if (e.target.id === "chatimg" && f) { resizeFile(f, 900).then(function (u) { CHAT.pendingImg = u; redrawChat(false); }); return true; }
    return false;
  }
  function extraInput(e) {
    if (e.target.id === "daynote") { DAY.note = e.target.value; clearTimeout(noteTimer); noteTimer = setTimeout(saveDay, 600); return true; }
    if (e.target.id === "chatin") { CHAT.draft = e.target.value; e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px"; return true; }
    return false;
  }
  document.addEventListener("submit", function (e) { extraSubmit(e); });
  document.addEventListener("keydown", function (e) {
    if (e.target.id === "chatin" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); var f = $("#chatf"); if (f) f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); }
  });
  function fillExtraBoards(root) {
    (root || document).querySelectorAll("img[data-tripboard]").forEach(function (im) { var p = im.dataset.tripboard.split(":"), t = TRIPS[+p[0]]; if (t && t.days[+p[1]]) boardFor(t.days[+p[1]].b).then(function (u) { im.src = u; }); });
    (root || document).querySelectorAll("img[data-buyboard]").forEach(function (im) { var b = BUY.res && BUY.res.looks[+im.dataset.buyboard]; if (b) boardFor(b).then(function (u) { im.src = u; }); });
  }
  /* ---------- rotation of wardrobe photos ---------- */
  function rotOf(id) { return ((S.rot[id] || 0) % 360 + 360) % 360; }
  function rotStyle(id) { var r = rotOf(id); return r ? ' style="transform:rotate(' + r + 'deg)"' : ""; }

  /* ---------- flat-lay board drawn on canvas (same layout as the ready boards) ---------- */
  var boardCache = {}, imgCache = {};
  function loadImg(src) {
    if (!src) return Promise.resolve(null);
    if (imgCache[src]) return imgCache[src];
    imgCache[src] = new Promise(function (res) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { res(null); }; i.src = src; });
    return imgCache[src];
  }
  function asset(p) { return window.VAULT ? window.VAULT.url(p) : p; }
  function itemSrc(x) { return x.photo ? photos["item_" + x.id] : asset("img/i/" + x.id + ".webp"); }
  function boardFor(b) {
    b = b || {};
    var key = SLOTS.map(function (s) { return (b[s[0]] || "-") + "@" + (b[s[0]] ? rotOf(b[s[0]]) : 0); }).join("|");
    if (boardCache[key]) return boardCache[key];
    var W = 900, H = 1200, hasO = !!b.outer, hasJ = !!b.mid, B;
    if (hasO && hasJ) B = { outer: [20, 20, 450, 760], mid: [440, 20, 880, 430], base: [470, 350, 870, 720], bottom: [470, 690, 885, 1185], shoes: [300, 900, 470, 1180], tank: [40, 790, 300, 1040] };
    else if (hasO) B = { outer: [20, 20, 450, 780], base: [450, 30, 880, 520], bottom: [470, 510, 885, 1185], shoes: [50, 850, 430, 1140], tank: [40, 790, 300, 1040] };
    else if (hasJ) B = { mid: [20, 20, 450, 720], base: [450, 30, 880, 520], bottom: [470, 510, 885, 1185], shoes: [50, 800, 430, 1110], tank: [40, 790, 300, 1040] };
    else B = { base: [180, 30, 720, 560], bottom: [200, 530, 700, 1185], shoes: [610, 880, 885, 1150], tank: [40, 120, 330, 480] };
    var order = ["outer", "bottom", "mid", "base", "tank", "shoes"];
    boardCache[key] = Promise.all(order.map(function (k) { var x = b[k] && ITEM[b[k]]; return x ? loadImg(itemSrc(x)) : Promise.resolve(null); })).then(function (ims) {
      var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      var g = cv.getContext("2d"); g.fillStyle = "#F4F2EE"; g.fillRect(0, 0, W, H);
      ims.forEach(function (im, i) {
        var k = order[i], x = b[k] && ITEM[b[k]], bx = B[k]; if (!im || !bx) return;
        var rot = rotOf(x.id), side = rot % 180 === 90, iw = side ? im.height : im.width, ih = side ? im.width : im.height;
        var bw = bx[2] - bx[0], bh = bx[3] - bx[1], r = Math.min(bw / iw, bh / ih), w = im.width * r, h = im.height * r;
        var cx = bx[0] + bw / 2, cy = bx[1] + bh / 2;
        g.save(); g.translate(cx, cy); g.rotate(rot * Math.PI / 180);
        g.shadowColor = "rgba(60,45,30,.22)"; g.shadowBlur = 26; g.shadowOffsetX = 6; g.shadowOffsetY = 12;
        if (x.photo || x.card) { g.beginPath(); if (g.roundRect) g.roundRect(-w / 2, -h / 2, w, h, 18); else g.rect(-w / 2, -h / 2, w, h); g.fillStyle = "#fff"; g.fill(); g.shadowColor = "transparent"; g.clip(); }
        g.drawImage(im, -w / 2, -h / 2, w, h); g.restore();
      });
      try { return cv.toDataURL("image/jpeg", 0.86); } catch (e) { return ""; }
    });
    return boardCache[key];
  }

  /* ---------- small UI helpers ---------- */
  var IC = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
    looks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="7.5" height="10" rx="2"/><rect x="13" y="3.5" width="7.5" height="6" rx="2"/><rect x="3.5" y="15.5" width="7.5" height="5" rx="2"/><rect x="13" y="11.5" width="7.5" height="9" rx="2"/></svg>',
    build: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M12 8v8M8 12h8"/></svg>',
    wardrobe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.5a2 2 0 1 1 2 2c-1 0-2 .6-2 1.6v.4"/><path d="M12 9.5 3.2 15.6c-.8.6-.4 1.6.5 1.6h16.6c.9 0 1.3-1 .5-1.6z"/></svg>',
    mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
    heartOn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
    back: '<svg viewBox="0 0 13 21" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2 2.5 10.5 11 19"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 2.5l1.7 5.1 5.1 1.7-5.1 1.7L11 16.1 9.3 11 4.2 9.3 9.3 7.6zM18.5 13.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/></svg>',
    swap: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/></svg>',
    rotL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h5"/><path d="M4.6 14a8 8 0 1 0 1.9-8.3L4 9"/></svg>',
    suitcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M9 11v5M15 11v5"/></svg>',
    gaps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2" stroke-dasharray="2.4 2.2"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l7.9 7.9a1.5 1.5 0 0 1 0 2.1l-6 6a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8.3" cy="8.3" r="1.5"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5c-4.9 0-8.5 3.3-8.5 7.6 0 2.2 1 4.2 2.6 5.6-.2 1.3-.8 2.5-1.7 3.4 2 .1 3.6-.6 4.7-1.4.9.2 1.9.4 2.9.4 4.9 0 8.5-3.3 8.5-7.6S16.9 3.5 12 3.5z" opacity=".22"/><path d="M11 6.6l1 3.1 3.1 1-3.1 1-1 3.1-1-3.1-3.1-1 3.1-1zM16.3 12.8l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5a1 1 0 0 1 .7.3l6 6a1 1 0 1 1-1.4 1.4L13 7.9V19a1 1 0 1 1-2 0V7.9l-4.3 4.3a1 1 0 1 1-1.4-1.4l6-6a1 1 0 0 1 .7-.3z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6"/></svg>',
    rotR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v5h-5"/><path d="M19.4 14a8 8 0 1 1-1.9-8.3L20 9"/></svg>'
  };
  var TABS = [["today", "Сегодня"], ["looks", "Образы"], ["wardrobe", "Гардероб"], ["mine", "Мои"]];
  function renderTabs() {
    var fab = document.querySelector("nav.tabs .fab"); if (fab && !fab.firstChild) fab.innerHTML = IC.chat;
    $("#tabs").innerHTML = TABS.map(function (t) { return '<button type="button" data-tab="' + t[0] + '"' + (S.tab === t[0] || (S.tab === "build" && t[0] === "looks") ? ' aria-current="page"' : "") + ">" + IC[t[0]] + "<span>" + t[1] + "</span></button>"; }).join("");
  }
  function lt(eyebrow, title, sub, action, back) {
    return '<header class="lt' + (action ? " act" : "") + '">' + (back ? '<button type="button" class="ltback" data-tab="' + back[0] + '">' + IC.back + back[1] + "</button>" : "") +
      '<div class="ltt">' + (eyebrow ? '<div class="eyebrow">' + esc(eyebrow) + "</div>" : "") + "<h1>" + esc(title) + "</h1>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>" + (action || "") + "</header>";
  }
  function sec(head, body, right) { return '<section class="sec">' + (head ? '<h2 class="sh">' + esc(head) + (right ? "<b>" + right + "</b>" : "") + "</h2>" : "") + body + "</section>"; }
  function lookImg(l, mode) {
    if (l.custom) return mode === "b" ? "" : (photos["sk_" + l.key] || "");
    return asset(mode === "b" || !l.sk ? "img/b/" + pad(l.id) + ".webp" : "img/s/" + pad(l.id) + ".webp");
  }
  function heart(k) { var on = S.fav.indexOf(k) >= 0; return '<button type="button" class="heart" data-fav="' + k + '" aria-label="' + (on ? "Убрать из избранного" : "Добавить в избранное") + '" aria-pressed="' + on + '">' + (on ? IC.heartOn : IC.heart) + "</button>"; }
  function card(l, ctx, opts) {
    opts = opts || {}; var src = lookImg(l);
    return '<div class="card' + (opts.hero ? " hero" : "") + (opts.tall ? " tall" : "") + '"><button type="button" data-look="' + l.key + '" data-ctx="' + ctx + '" style="display:block;width:100%;text-align:left">' +
      "<img " + (opts.hero ? "" : 'loading="lazy" ') + (src ? 'src="' + src + '"' : 'data-board="' + l.key + '"') + ' alt="">' +
      '<span class="meta"><span class="name">' + esc(l.title) + '</span><span class="note">' + esc(opts.note || (l.custom ? "Мой образ" : l.temp + "°")) + "</span></span></button>" + heart(l.key) + "</div>";
  }
  function fillBoards(root) {
    (root || document).querySelectorAll("img[data-board]").forEach(function (im) { var l = look(im.dataset.board); if (l) boardFor(l.b).then(function (u) { im.src = u; }); });
  }
  var CTX = {};
  function ctxList(name, keys) { CTX[name] = keys; return name; }
  function itemImg(x) { var s = itemSrc(x); return s ? '<img loading="lazy" src="' + s + '" alt=""' + rotStyle(x.id) + ">" : ""; }
  function tile(x, attr) {
    var n = usage(x.id).length, note = x.off ? x.off : x.rare ? "редко" : "";
    return '<button type="button" class="tile" ' + (attr || 'data-item="' + x.id + '"') + '><span class="ph' + (x.photo || x.card ? " card" : "") + '">' + itemImg(x) + '</span><span class="nm">' + esc(x.name) + '</span><span class="ct">' +
      (note ? esc(note) + " · " : "") + (n ? n + " " + plural(n, "образ", "образа", "образов") : "нет в образах") + "</span></button>";
  }
  function usage(id) { return D.looks.concat(S.my).filter(function (l) { return l.items.indexOf(id) >= 0; }); }
  function howList(arr) { return '<div class="group">' + arr.map(function (s, i) { return '<div class="row"><span class="num">' + (i + 1) + '</span><span class="grow">' + esc(s) + "</span></div>"; }).join("") + "</div>"; }

  /* ---------- screens ---------- */
  function viewToday() {
    var c = cond(), p = picks(), w = S.wx, wx;
    var date = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
    if (w) {
      wx = '<div class="wx"><div class="deg">' + sgn(w.t) + '°</div><div class="info"><span class="cond' + (w.rain ? " rain" : "") + '">' + wxText(w.code) + (w.rain && w.code < 51 ? ", возможен дождь" : "") + '</span>' +
        '<span class="foot">Ощущается ' + sgn(w.feels) + "°. Днём " + sgn(w.min) + "…" + sgn(w.max) + "°</span>" +
        '<span class="foot">Ветер ' + w.wind + " км/ч · осадки " + w.p + "%</span></div></div>";
    } else {
      wx = '<div class="wx"><div class="deg">' + sgn(c.t) + '°</div><div class="info"><span class="cond">Прогноз не загрузился</span><span class="foot">Укажите погоду вручную</span>' +
        '<div class="ctl"><span class="stepper"><button type="button" data-act="t-" aria-label="Холоднее">−</button><span>' + sgn(c.t) + '°</span><button type="button" data-act="t+" aria-label="Теплее">+</button></span>' +
        '<button type="button" class="chip" data-act="rain" aria-pressed="' + c.rain + '">Дождь</button><button type="button" class="chip" data-act="reload">Обновить</button></div></div></div>';
    }
    var h = p[0], cx = ctxList("today", p.map(function (l) { return l.key; }));
    var note = "Для " + h.temp + "°" + (c.rain && hasItem(h, function (x) { return x.rain; }) ? " · мартинсы на случай луж" : "");
    return lt(date, "Сегодня", esc(S.city.name)) +
      sec("", wx) +
      sec("Главный вариант", card(h, cx, { hero: true, note: note })) +
      sec("Ещё подходит", '<div class="duo">' + card(p[1], cx) + card(p[2], cx) + "</div>" +
        '<button type="button" class="btn gray" data-act="more">Показать другие</button>') +
      sec("Нет подходящего?", '<button type="button" class="btn fill" data-act="gen">' + IC.spark + "Сгенерировать новый образ</button>" +
        '<p class="foot" style="padding-inline:16px">Соберу образ из ваших вещей под сегодняшнюю погоду. Его можно поправить и сохранить.</p>');
  }

  function tband(l) { return l.t[0] <= 0 ? "cold" : (l.t[0] <= 3 ? "mid" : "warm"); }
  function viewLooks() {
    var dirs = [["all", "Все"]].concat(Object.keys(DIRS).filter(function (k) { return k !== "mine" || S.my.length; }).map(function (k) { return [k, k === "mine" ? "Мои" : DIRS[k]]; }));
    var ts = [["all", "Любая"], ["cold", "Холод"], ["mid", "0…+8°"], ["warm", "+3…+10°"]];
    var src = D.looks.concat(S.my), list = src.filter(function (l) { return (S.fDir === "all" || l.dir === S.fDir) && (S.fT === "all" || l.custom || tband(l) === S.fT); });
    var cx = ctxList("looks", list.map(function (l) { return l.key; }));
    return lt("", "Образы", list.length + " " + plural(list.length, "образ", "образа", "образов"), '<button type="button" class="ltbtn" data-tab="build" aria-label="Собрать новый образ">' + IC.plus + "</button>") +
      sec("", '<div class="chips">' + dirs.map(function (d) { return '<button type="button" class="chip" data-fdir="' + d[0] + '" aria-pressed="' + (S.fDir === d[0]) + '">' + d[1] + "</button>"; }).join("") + "</div>" +
        '<div class="seg" role="group" aria-label="Погода">' + ts.map(function (d) { return '<button type="button" data-ft="' + d[0] + '" aria-pressed="' + (S.fT === d[0]) + '">' + d[1] + "</button>"; }).join("") + "</div>") +
      sec("", list.length ? '<div class="masonry">' + list.map(function (l) { return card(l, cx, { tall: l.sk || l.custom }); }).join("") + "</div>" : '<div class="empty">Под такой фильтр образов нет.</div>');
  }

  function viewWardrobe() {
    var cats = [["all", "Все"]].concat(Object.keys(CATS).map(function (k) { return [k, CATS[k]]; }));
    var q = S.q.trim().toLowerCase();
    var list = allItems().filter(function (x) { return (S.fCat === "all" || x.cat === S.fCat) && (!q || x.name.toLowerCase().indexOf(q) >= 0); })
      .sort(function (a, b) { return (b.photo ? 1 : 0) - (a.photo ? 1 : 0) || usage(b.id).length - usage(a.id).length || a.name.localeCompare(b.name, "ru"); });
    return lt("", "Гардероб", allItems().length + " " + plural(allItems().length, "вещь", "вещи", "вещей")) +
      sec("", '<label class="search">' + IC.search + '<input id="q" type="search" placeholder="Поиск" value="' + esc(S.q) + '" autocomplete="off"></label>' +
        '<div class="chips">' + cats.map(function (d) { return '<button type="button" class="chip" data-fcat="' + d[0] + '" aria-pressed="' + (S.fCat === d[0]) + '">' + d[1] + "</button>"; }).join("") + "</div>") +
      sec("", '<button type="button" class="btn tint" data-act="additem">Добавить вещь</button>') +
      sec(list.length ? (S.fCat === "all" ? "Все вещи" : CATS[S.fCat]) : "", list.length ? '<div class="items">' + list.map(function (x) { return tile(x); }).join("") + "</div>" : '<div class="empty">Ничего не нашлось.</div>', list.length ? String(list.length) : "");
  }

  function viewBuild() {
    if (!S.build) S.build = generate(cond()) || {};
    var b = S.build, c = cond(), how = howFor(b, c);
    var rows = SLOTS.map(function (s) {
      var x = b[s[0]] && ITEM[b[s[0]]];
      return '<button type="button" class="row th" data-slot="' + s[0] + '"><span class="thumb' + (x && (x.photo || x.card) ? " card" : "") + '">' + (x ? itemImg(x) : "") + '</span><span class="grow"><span class="small">' + s[1] + "</span><span>" + (x ? esc(x.name) : '<span class="v">Не выбрано</span>') + '</span></span><span class="chev">›</span></button>';
    }).join("");
    return lt(sgn(c.t) + "°" + (c.rain ? " · дождь" : ""), "Собрать образ", "", "", ["looks", "Образы"]) +
      sec("", '<div class="media"><img id="buildimg" alt="Доска собранного образа"></div>' +
        '<div class="pair"><button type="button" class="btn tint" data-act="gen">' + IC.spark + 'Другой</button><button type="button" class="btn gray" data-act="clear">Очистить</button></div>') +
      sec("Вещи", '<div class="group">' + rows + "</div>") +
      (how.length ? sec("Как носить", howList(how)) : "") +
      sec("Название", '<div class="group"><div class="row"><input id="btitle" class="field" value="' + esc(S.buildTitle || makeTitle(b)) + '" aria-label="Название образа"></div>' +
        '<label class="row upl"><span class="grow" style="color:var(--accent)">' + (S.buildPhoto ? "Фото образа добавлено" : "Добавить своё фото образа") + '</span><span class="chev">' + (S.buildPhoto ? "✓" : "›") + '</span><input type="file" accept="image/*" id="buildphoto"></label></div>') +
      sec("", '<button type="button" class="btn fill" data-act="save">Сохранить в «Мои»</button><button type="button" class="btn gray" data-act="prompt">Нарисовать скетч в Gemini</button>');
  }
  function drawBuild() { var im = $("#buildimg"); if (im) boardFor(S.build).then(function (u) { if ($("#buildimg") === im) im.src = u; }); }

  function viewMine() {
    var my = S.my.slice().reverse(), fav = S.fav.map(look).filter(Boolean), isMy = S.mineSeg === "my";
    var list = isMy ? my : fav, cx = ctxList("mine", list.map(function (l) { return l.key; }));
    return lt("", "Мои") +
      sec("", '<div class="seg" role="group"><button type="button" data-mseg="my" aria-pressed="' + isMy + '">Собранные · ' + my.length + '</button><button type="button" data-mseg="fav" aria-pressed="' + !isMy + '">Избранное · ' + fav.length + "</button></div>") +
      sec("", list.length ? '<div class="masonry">' + list.map(function (l) { return card(l, cx, { tall: l.sk || l.custom }); }).join("") + "</div>" :
        '<div class="empty">' + (isMy ? "Здесь появятся образы, которые вы соберёте или сгенерируете." : "Нажмите на сердечко у образа, и он появится здесь.") + "</div>" +
        (isMy ? '<button type="button" class="btn tint" data-act="gen">' + IC.spark + "Сгенерировать первый образ</button>" : "")) +
      (window.VAULT ? sec("", '<button type="button" class="btn danger" data-act="vlock">Закрыть гардероб на этом устройстве</button><p class="foot" style="text-align:center">Чтобы открыть снова, понадобится пароль</p>') : "") +
      (SRV && SRV.kv ? sec("", '<p class="foot" style="text-align:center">Синхронизируется между устройствами</p><button type="button" class="btn danger" data-act="logout">Выйти на этом устройстве</button>') : "");
  }

  function render() {
    renderTabs();
    $("#app").innerHTML = { today: viewDay, looks: viewLooks, build: viewBuild, wardrobe: viewWardrobe, mine: viewMine }[S.tab]();
    fillBoards($("#app")); fillExtraBoards($("#app")); if (S.tab === "build") drawBuild();
  }

  /* ---------- sheets (full-screen, iOS navigation bar) ---------- */
  var stack = [];
  function openSheet(fn) { stack.push(fn); drawSheet(); if (tg && tg.BackButton) tg.BackButton.show(); }
  function drawSheet(anim) {
    var s = $("#sheet");
    if (!stack.length) { s.innerHTML = ""; document.body.style.overflow = ""; if (tg && tg.BackButton) tg.BackButton.hide(); return; }
    var prev = $(".sheet"), top = prev && anim === "keep" ? prev.scrollTop : 0;
    var v = stack[stack.length - 1]();
    s.innerHTML = '<div class="sheet' + (v.cls ? " " + v.cls : "") + '" role="dialog" aria-modal="true">' + v.nav + '<div class="body' + (anim && anim !== "keep" ? " " + anim : "") + '">' + v.body + "</div></div>";
    document.body.style.overflow = "hidden"; fillBoards(s); fillExtraBoards(s);
    var el = $(".sheet"); if (el) el.scrollTop = top;
    if (anim && anim !== "keep") s.querySelector(".sheet").style.animation = "none";
  }
  function closeSheet() { stack.pop(); drawSheet(); render(); }
  function nav(title, action) { return '<div class="nb"><div class="in"><button type="button" class="back" data-act="back" aria-label="Назад">' + IC.back + "</button><span class=\"ttl\">" + esc(title || "") + "</span>" + (action || "<span></span>") + "</div></div>"; }

  var cur = { key: null, ctx: null };
  function lookSheet(k, ctx, mode) {
    return function () {
      var l = look(k); if (!l) return { nav: nav(""), body: '<div class="empty">Образ удалён.</div>' };
      cur = { key: k, ctx: ctx };
      var list = CTX[ctx] || [k], i = list.indexOf(k), on = S.fav.indexOf(k) >= 0, ph = photos[k], msk = l.custom && photos["sk_" + k];
      var hasSk = l.sk || msk;
      var m = mode || (hasSk ? "sk" : ph && l.custom ? "me" : "b"), views = [];
      if (hasSk) views.push(["sk", l.custom ? "Скетч" : "Как носить"]);
      views.push(["b", "Доска"]);
      if (ph) views.push(["me", "Моё фото"]);
      var src = m === "me" ? ph : lookImg(l, m);
      var dots = list.length > 1 && list.length <= 9 ? '<div class="dots">' + list.map(function (_, j) { return "<i" + (j === i ? ' class="on"' : "") + "></i>"; }).join("") + "</div>" :
        list.length > 9 ? '<div class="dots foot t">' + (i + 1) + " из " + list.length + "</div>" : "";
      var body =
        '<section class="sec"><div class="media" data-swipe><img ' + (src ? 'src="' + src + '"' : 'data-board="' + l.key + '"') + ' alt="' + esc(l.title) + '">' +
        (list.length > 1 ? '<button type="button" class="nav prev" data-step="-1" aria-label="Предыдущий образ">‹</button><button type="button" class="nav next" data-step="1" aria-label="Следующий образ">›</button>' : "") + "</div>" + dots +
        (views.length > 1 ? '<div class="seg" role="group">' + views.map(function (v) { return '<button type="button" data-mode="' + v[0] + '" aria-pressed="' + (m === v[0]) + '">' + v[1] + "</button>"; }).join("") + "</div>" : "") + "</section>" +
        '<section class="sec titleblock"><h2 class="title">' + esc(l.title) + '</h2><div class="badges">' + (l.custom ? '<span class="badge">Мой образ</span>' : '<span class="badge t">' + esc(l.temp) + '°</span><span class="badge">' + esc(DIRS[l.dir]) + "</span>") + (l.occ ? '<span class="badge">' + esc(l.occ) + "</span>" : "") + "</div></section>" +
        sec("Как носить", howList(l.how)) +
        (l.alts && l.alts.length ? sec("Можно заменить", '<div class="group">' + l.alts.map(function (a) { return '<div class="row"><span class="ico">' + IC.swap + '</span><span class="grow"><span>' + esc(a[0]) + '</span><span class="small">' + esc(a[1]) + "</span></span></div>"; }).join("") + "</div>") : "") +
        (l.acc ? sec("Аксессуары", '<div class="group"><div class="row"><span class="grow">' + esc(l.acc) + "</span></div></div>") : "") +
        sec("Вещи образа", '<div class="strip">' + l.items.filter(function (id) { return ITEM[id]; }).map(function (id) { return tile(ITEM[id]); }).join("") + "</div>") +
        sec("", '<div class="group"><label class="row upl"><span class="grow" style="color:var(--accent)">' + (ph ? "Заменить моё фото в этом образе" : "Добавить моё фото в этом образе") + '</span><span class="chev">›</span><input type="file" accept="image/*" data-lookphoto="' + k + '"></label>' +
          (l.custom ? '<button type="button" class="row" data-act="looksketch"><span class="grow" style="color:var(--accent)">Нарисовать скетч в Gemini</span><span class="chev">›</span></button>' +
            '<label class="row upl"><span class="grow" style="color:var(--accent)">' + (msk ? "Заменить скетч" : "Загрузить скетч из Gemini") + '</span><span class="chev">›</span><input type="file" accept="image/*" data-looksketch="' + k + '"></label>' +
            '<button type="button" class="row" data-act="editlook"><span class="grow" style="color:var(--accent)">Изменить в «Собрать»</span><span class="chev">›</span></button>' : "") + "</div>" +
          (l.custom ? '<button type="button" class="btn danger" data-act="dellook">Удалить образ</button>' : ""));
      var act = '<button type="button" class="act" data-fav="' + k + '" aria-pressed="' + on + '" aria-label="Избранное">' + (on ? IC.heartOn : IC.heart) + "</button>";
      return { nav: nav(l.title, act), body: body };
    };
  }
  function stepLook(d) {
    var list = CTX[cur.ctx] || []; if (list.length < 2) return;
    var i = list.indexOf(cur.key), n = list[(i + d + list.length) % list.length];
    loadPhoto(n).then(function () { stack[stack.length - 1] = lookSheet(n, cur.ctx); drawSheet(d > 0 ? "from-r" : "from-l"); haptic(); });
  }
  function itemSheet(id) {
    return function () {
      var x = ITEM[id]; if (!x) return { nav: nav(""), body: "" };
      var u = usage(id), cx = ctxList("item", u.map(function (l) { return l.key; }));
      var body =
        sec("", '<div class="itemhero' + (x.photo || x.card ? " card" : "") + '">' + itemImg(x).replace(' loading="lazy"', "") +
          '<button type="button" class="rotbtn" data-rot="90" aria-label="Повернуть фото на 90°" title="Повернуть">' + IC.rotR + "</button></div>") +
        '<section class="sec titleblock"><h2 class="title">' + esc(x.name) + '</h2><div class="badges"><span class="badge">' + esc(CATS[x.cat] || "") + "</span>" + (x.off ? '<span class="badge">' + esc(x.off) + "</span>" : "") + (x.rare ? '<span class="badge">редко ношу</span>' : "") + "</div>" +
          ((x.off || x.rare) ? '<p class="foot">В генерацию образов не попадает, но её можно выбрать вручную.</p>' : "") + "</section>" +
        sec("", '<button type="button" class="btn fill" data-buildwith="' + id + '">Собрать образ с этой вещью</button>') +
        (u.length ? sec("Есть в образах", '<div class="masonry">' + u.map(function (l) { return card(l, cx, { tall: l.sk || l.custom }); }).join("") + "</div>", String(u.length)) : "") +
        (x.photo ? sec("", '<button type="button" class="btn danger" data-delitem="' + id + '">Удалить вещь</button>') : "");
      return { nav: nav(x.name), body: body };
    };
  }
  function slotSheet(slot) {
    return function () {
      var s = SLOTS.filter(function (z) { return z[0] === slot; })[0], t = cond().t, chosen = (S.build || {})[slot];
      var list = allItems().filter(function (x) { return s[2].indexOf(x.sub) >= 0; }).sort(function (a, b) { return (usable(b, t) ? 1 : 0) - (usable(a, t) ? 1 : 0) || a.name.localeCompare(b.name, "ru"); });
      var body = sec("", '<div class="group"><button type="button" class="row" data-pslot="' + slot + '" data-pickitem=""><span class="grow">Без этого слоя</span>' + (!chosen ? '<span style="color:var(--accent)">✓</span>' : "") + "</button></div>") +
        sec("Выберите вещь", '<div class="items">' + list.map(function (x) { return tile(x, 'data-pslot="' + slot + '" data-pick="' + x.id + '"' + (chosen === x.id ? ' aria-current="true"' : "")); }).join("") + "</div>", String(list.length));
      return { nav: nav(s[1]), body: body };
    };
  }
  var addDraft = { photo: null, name: "", cat: "base" };
  var ADDCATS = [["base", "Футболка, лонгслив, рубашка", "top"], ["warm", "Свитер, свитшот", "top"], ["tank", "Майка, топ", "top"], ["mid", "Пиджак, кардиган", "layer"],
    ["bottom", "Брюки, джинсы", "bottom"], ["skirt", "Юбка", "bottom"], ["outer", "Верхняя одежда", "outer"], ["shoes", "Обувь", "shoes"]];
  function addSheet() {
    return function () {
      var body = sec("", '<label class="drop upl">' + (addDraft.photo ? '<img src="' + addDraft.photo + '" alt="">' : "Сфотографировать или выбрать фото") + '<input type="file" accept="image/*" id="newphoto"></label>' +
          '<p class="foot" style="padding-inline:16px">Лучше снимать на однотонном фоне при дневном свете.</p>') +
        sec("Название", '<div class="group"><div class="row"><input id="newname" class="field" placeholder="Например, свитер серый с косами" value="' + esc(addDraft.name) + '"></div></div>') +
        sec("Что это", '<div class="chips wrapx">' + ADDCATS.map(function (c) { return '<button type="button" class="chip" data-newcat="' + c[0] + '" aria-pressed="' + (addDraft.cat === c[0]) + '">' + c[1] + "</button>"; }).join("") + "</div>") +
        sec("", '<button type="button" class="btn fill" data-act="saveitem">Сохранить в гардероб</button><p class="foot" style="padding-inline:16px">Фото хранится на этом устройстве. Вещь сразу появится в «Собрать» и в генерации.</p>');
      return { nav: nav("Новая вещь"), body: body };
    };
  }
  var promptText = "", promptKey = null, promptBoard = null;
  // promptKey: a saved look the finished sketch goes into; promptBoard: slot map to draw the board for Gemini
  function promptSheet() {
    return function () {
      var steps = ["Сохраните доску образа: нажмите на неё и удерживайте → «Сохранить изображение».", "Скопируйте промпт.",
        "В Gemini включите создание изображений, приложите доску и вставьте промпт.",
        promptKey ? "Сохраните картинку из Gemini и загрузите её сюда — она станет обложкой образа." : "Сохраните образ в «Мои», затем загрузите туда картинку из Gemini."];
      var body = sec("Доска для Gemini", '<div class="media"><img id="pboard" alt="Доска образа"></div>' +
          '<a class="btn gray" id="pboarddl" download="obraz.jpg" hidden>Сохранить доску</a>') +
        sec("Как сделать скетч", howList(steps)) +
        sec("Промпт", '<div class="group"><div class="row"><textarea id="ptext" class="field" readonly>' + esc(promptText) + "</textarea></div></div>") +
        sec("", '<button type="button" class="btn fill" data-act="copy">Скопировать промпт</button><a class="btn tint" href="https://gemini.google.com/app" target="_blank" rel="noopener" data-gemini>Открыть Gemini</a>') +
        (promptKey ? sec("Готовый скетч", '<div class="group"><label class="row upl"><span class="grow" style="color:var(--accent)">' + (photos["sk_" + promptKey] ? "Заменить скетч в образе" : "Загрузить скетч из Gemini") +
          '</span><span class="chev">›</span><input type="file" accept="image/*" data-looksketch="' + promptKey + '"></label></div>') : "");
      setTimeout(function () {
        boardFor(promptBoard || {}).then(function (u) { var im = $("#pboard"), a = $("#pboarddl"); if (im) im.src = u; if (a && u) { a.href = u; a.hidden = false; } });
      }, 0);
      return { nav: nav("Скетч в Gemini"), body: body };
    };
  }
  function makePrompt(title, items, how) {
    return "Нарисуй вертикальную (формат 2:3) fashion-иллюстрацию «как носить»: акварель и тушь на кремовой бумаге, фигура в полный рост, тонкие выноски с подписями, слева столбик мазков-палитры без подписей. " +
      "Героиня — " + ((D.profile || {}).look || "девушка, лицо прорисовано.") + " Одежда — только вещи с приложенной доски, те же цвета и принты: " +
      items.map(function (i) { return ITEM[i] ? ITEM[i].name : ""; }).filter(Boolean).join("; ") + ". Как носить: " + how.join(" ") +
      " Подписи на русском, коротко, только к одежде и обуви. Вверху заголовок «" + title + "». Без водяных знаков.";
  }

  /* ---------- my looks persistence ---------- */
  function saveMy(m) { kv.set("ml_" + m.key, { k: m.key, n: m.title, b: m.b, h: m.how, d: m.created }); kv.set("ml_index", S.my.map(function (x) { return x.key; })); }
  function toMy(r) { return { key: r.k, custom: true, dir: "mine", title: r.n, b: r.b, items: buildItems(r.b), how: r.h || [], acc: "", alts: [], temp: "мой", t: [-30, 40], occ: "", created: r.d }; }

  /* ---------- events ---------- */
  function toast(t) { var e = $("#toast"); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { e.hidden = true; }, 1800); }
  function haptic(kind) { try { if (!tg || !tg.HapticFeedback) return; if (kind) tg.HapticFeedback.notificationOccurred(kind); else tg.HapticFeedback.selectionChanged(); } catch (e) {} }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-gemini]"); if (a && tg && tg.openLink) { e.preventDefault(); tg.openLink(a.href); return; }
    var b = e.target.closest("button"); if (!b) return;
    var d = b.dataset;
    if (extraClick(b, d)) return;
    if (d.tab) { S.tab = d.tab; stack = []; drawSheet(); render(); window.scrollTo(0, 0); haptic(); return; }
    if (d.fav) { var k = d.fav, i = S.fav.indexOf(k); if (i >= 0) S.fav.splice(i, 1); else { S.fav.unshift(k); toast("Добавлено в избранное"); } kv.set("fav", S.fav); haptic(); if (stack.length) drawSheet("keep"); else render(); return; }
    if (d.look) { var lk = d.look, cx = d.ctx; loadPhoto(lk).then(function () { openSheet(lookSheet(lk, cx)); }); haptic(); return; }
    if (d.step) { stepLook(+d.step); return; }
    if (d.item) { openSheet(itemSheet(d.item)); haptic(); return; }
    if (d.rot) { var id = curItem; if (!id) return; S.rot[id] = (rotOf(id) + (+d.rot) + 360) % 360; if (!S.rot[id]) delete S.rot[id]; kv.set("rot", S.rot); drawSheet("keep"); haptic(); return; }
    if (d.mode) { stack[stack.length - 1] = lookSheet(cur.key, cur.ctx, d.mode); drawSheet("keep"); return; }
    if (d.fdir) { S.fDir = d.fdir; render(); return; }
    if (d.ft) { S.fT = d.ft; render(); return; }
    if (d.fcat) { S.fCat = d.fcat; render(); return; }
    if (d.mseg) { S.mineSeg = d.mseg; render(); return; }
    if (d.slot) { openSheet(slotSheet(d.slot)); return; }
    if (d.pslot) { S.build = S.build || {}; if (d.pick) S.build[d.pslot] = d.pick; else delete S.build[d.pslot]; S.buildTitle = ""; stack = []; drawSheet(); render(); haptic(); return; }
    if (d.buildwith) { var it = ITEM[d.buildwith], slot = SLOTS.filter(function (s) { return s[2].indexOf(it.sub) >= 0; })[0][0]; S.build = generate(cond()) || {}; S.build[slot] = it.id; if (slot === "base" && !it.crop) delete S.build.tank; S.buildTitle = ""; S.tab = "build"; stack = []; drawSheet(); render(); window.scrollTo(0, 0); return; }
    if (d.newcat) { addDraft.name = ($("#newname") || {}).value || addDraft.name; addDraft.cat = d.newcat; drawSheet("keep"); return; }
    if (d.delitem) { var di = d.delitem; S.myItems = S.myItems.filter(function (x) { return x.id !== di; }); delete ITEM[di]; idb.set("myitems", S.myItems); idb.del("ph_item_" + di); closeSheet(); toast("Вещь удалена"); return; }
    switch (d.act) {
      case "back": closeSheet(); break;
      case "vlock": window.VAULT.lock(); break;
      case "logout": fetch("api/logout", { method: "POST", credentials: "same-origin" }).finally(function () { showLogin(); }); break;
      case "more": S.skip++; render(); haptic(); break;
      case "t-": S.manual.t--; S.skip = 0; S.build = null; render(); break;
      case "t+": S.manual.t++; S.skip = 0; S.build = null; render(); break;
      case "rain": S.manual.rain = !S.manual.rain; S.skip = 0; S.build = null; render(); break;
      case "reload": loadWeather(); toast("Загружаю прогноз"); break;
      case "gen": S.build = generate(cond()) || {}; S.buildTitle = ""; S.buildPhoto = null; S.tab = "build"; render(); window.scrollTo(0, 0); haptic(); break;
      case "clear": S.build = {}; S.buildTitle = ""; S.buildPhoto = null; render(); break;
      case "save": {
        var bb = S.build || {};
        if (!bb.base && !bb.bottom) { toast("Выберите хотя бы верх и низ"); break; }
        var key = "m" + Date.now().toString(36), title = ($("#btitle").value || makeTitle(bb)).trim();
        var m = toMy({ k: key, n: title, b: Object.assign({}, bb), h: howFor(bb, cond()), d: Date.now() });
        S.my.push(m); LOOK[key] = m; saveMy(m);
        if (S.buildPhoto) { photos[key] = S.buildPhoto; idb.set("ph_" + key, S.buildPhoto); }
        S.buildPhoto = null; toast("Сохранено в «Мои»"); haptic("success");
        S.tab = "mine"; S.mineSeg = "my"; render(); window.scrollTo(0, 0); break;
      }
      case "looksketch": { var ml = look(cur.key); promptKey = ml.key; promptBoard = ml.b; promptText = makePrompt(ml.title, ml.items, ml.how); openSheet(promptSheet()); break; }
      case "prompt": { var bp = S.build || {}; promptKey = null; promptBoard = bp; promptText = makePrompt(($("#btitle") || {}).value || makeTitle(bp), buildItems(bp), howFor(bp, cond())); openSheet(promptSheet()); break; }
      case "copy": {
        var ta = $("#ptext"), ok = function () { toast("Промпт скопирован"); haptic("success"); }, fb = function () { ta.removeAttribute("readonly"); ta.focus(); ta.select(); toast("Текст выделен, скопируйте его"); };
        try { navigator.clipboard.writeText(promptText).then(ok, fb); } catch (er) { fb(); }
        break;
      }
      case "editlook": { var l = look(cur.key); S.build = Object.assign({}, l.b); S.buildTitle = l.title; S.tab = "build"; stack = []; drawSheet(); render(); window.scrollTo(0, 0); break; }
      case "dellook": {
        var dk = cur.key; S.my = S.my.filter(function (x) { return x.key !== dk; }); delete LOOK[dk]; kv.del("ml_" + dk); kv.set("ml_index", S.my.map(function (x) { return x.key; }));
        S.fav = S.fav.filter(function (x) { return x !== dk; }); kv.set("fav", S.fav); idb.del("ph_" + dk); idb.del("ph_sk_" + dk); stack = []; drawSheet(); render(); toast("Образ удалён"); break;
      }
      case "additem": addDraft = { photo: null, name: "", cat: "base" }; openSheet(addSheet()); break;
      case "saveitem": {
        var nm = ($("#newname").value || "").trim();
        if (!addDraft.photo) { toast("Добавьте фото вещи"); break; }
        if (!nm) { toast("Напишите название"); break; }
        var c = ADDCATS.filter(function (x) { return x[0] === addDraft.cat; })[0], nid = "u" + Date.now().toString(36);
        var x = { id: nid, name: nm, cat: c[2], sub: c[0], photo: true, acc: false, summer: false, off: "", rare: false, rain: false, suede: /замш/i.test(nm), peplum: false, crop: false, tr: c[0] === "outer" ? [-10, 15] : null };
        photos["item_" + nid] = addDraft.photo; idb.set("ph_item_" + nid, addDraft.photo);
        S.myItems.push(x); ITEM[nid] = x; idb.set("myitems", S.myItems);
        closeSheet(); toast("Вещь добавлена"); haptic("success"); break;
      }
    }
  });
  var curItem = null;
  var _itemSheet = itemSheet; itemSheet = function (id) { var f = _itemSheet(id); return function () { curItem = id; return f(); }; };
  document.addEventListener("change", function (e) {
    if (extraChange(e)) return;
    var f = e.target.files && e.target.files[0]; if (!f) return;
    if (e.target.id === "newphoto") { addDraft.name = ($("#newname") || {}).value || addDraft.name; resizeFile(f, 900).then(function (u) { addDraft.photo = u; drawSheet("keep"); }); return; }
    if (e.target.id === "buildphoto") { resizeFile(f, 1200).then(function (u) { S.buildPhoto = u; S.buildTitle = $("#btitle").value; render(); toast("Фото прикреплено"); }); return; }
    var sk = e.target.dataset.looksketch;
    if (sk) {
      resizeFile(f, 1400).then(function (u) {
        photos["sk_" + sk] = u; idb.set("ph_sk_" + sk, u);
        if (promptKey === sk && stack.length > 1) { stack.pop(); promptKey = null; }
        stack[stack.length - 1] = lookSheet(sk, cur.ctx, "sk"); drawSheet("keep"); toast("Скетч добавлен в образ"); haptic("success");
      });
      return;
    }
    var lk = e.target.dataset.lookphoto;
    if (lk) resizeFile(f, 1200).then(function (u) { photos[lk] = u; idb.set("ph_" + lk, u); stack[stack.length - 1] = lookSheet(lk, cur.ctx, "me"); drawSheet("keep"); toast("Фото сохранено"); });
  });
  document.addEventListener("input", function (e) {
    if (extraInput(e)) return;
    if (e.target.id === "btitle") S.buildTitle = e.target.value;
    if (e.target.id === "q") { S.q = e.target.value; var pos = e.target.selectionStart; render(); var q = $("#q"); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (er) {} } }
  });
  document.addEventListener("keydown", function (e) {
    if (!stack.length) return;
    if (e.key === "Escape") closeSheet();
    if (cur.key && /Arrow(Left|Right)/.test(e.key) && !/INPUT|TEXTAREA/.test(e.target.tagName) && $(".sheet [data-swipe]")) stepLook(e.key === "ArrowRight" ? 1 : -1);
  });
  var sx = null, sy = 0;
  document.addEventListener("touchstart", function (e) { if (!e.target.closest(".sheet [data-swipe]")) { sx = null; return; } sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  document.addEventListener("touchend", function (e) {
    if (sx == null) return; var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepLook(dx < 0 ? 1 : -1);
  }, { passive: true });

  /* ---------- Telegram ---------- */
  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    var p = tg.themeParams, r = document.documentElement.style;
    var map = { secondary_bg_color: "--bg", bg_color: "--surface", text_color: "--fg", hint_color: "--fg2", button_color: "--accent", button_text_color: "--accent-fg" };
    Object.keys(map).forEach(function (k) { if (p[k]) r.setProperty(map[k], p[k]); });
    document.documentElement.dataset.theme = tg.colorScheme === "dark" ? "dark" : "light";
    try { tg.setHeaderColor("secondary_bg_color"); tg.setBackgroundColor("secondary_bg_color"); } catch (e) {}
  }
  function initTg() {
    tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData) { tg = null; return; }
    tg.ready(); tg.expand(); applyTheme(); tg.onEvent("themeChanged", applyTheme);
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    tg.BackButton.onClick(function () { if (stack.length) closeSheet(); });
  }
  function boot(done) {
    // re-entrant: rebuilds my looks and my items from storage (also used to pull changes from the server)
    S.my.forEach(function (m) { delete LOOK[m.key]; }); S.myItems.forEach(function (x) { delete ITEM[x.id]; });
    S.my = []; S.myItems = []; photos = {};
    kv.get(["fav", "ml_index", "rot"], function (v) {
      S.fav = parse(v.fav, []).map(String); S.rot = parse(v.rot, {}) || {};
      var idx = parse(v.ml_index, []);
      var finish = function () {
        idb.get("myitems").then(function (mi) {
          S.myItems = mi || [];
          return Promise.all(S.myItems.map(function (x) { ITEM[x.id] = x; return idb.get("ph_item_" + x.id).then(function (u) { photos["item_" + x.id] = u; }); }));
        }).then(function () {
          S.my.forEach(function (m) { m.items = buildItems(m.b); }); indexMy();
          return Promise.all(S.my.map(function (m) { return loadPhoto("sk_" + m.key); }));
        }).then(function () {
          if (stack.length) drawSheet("keep"); render();
          if (!done) loadWeather();
        });
      };
      if (!idx.length) { finish(); return; }
      kv.get(idx.map(function (k) { return "ml_" + k; }), function (vals) { S.my = idx.map(function (k) { return parse(vals["ml_" + k], null); }).filter(Boolean).map(toMy); finish(); });
    });
  }

  /* ---------- sync server: login and pulling changes made on the other device ---------- */
  function showLogin(msg) {
    stack = []; drawSheet(); document.body.classList.add("locked");
    $("#app").innerHTML = '<div class="login"><div class="logo">' + IC.wardrobe + '</div><h1>Капсула</h1><p class="foot">Войдите, чтобы гардероб был одинаковым на iPhone и iPad.</p>' +
      '<form id="loginf" class="group"><div class="row"><input id="pw" class="field" type="password" autocomplete="current-password" placeholder="Пароль" required></div></form>' +
      (msg ? '<p class="foot err">' + esc(msg) + "</p>" : "") +
      '<button type="submit" form="loginf" class="btn fill">Войти</button></div>';
    $("#tabs").innerHTML = "";
    setTimeout(function () { var p = $("#pw"); if (p) p.focus(); }, 50);
  }
  document.addEventListener("submit", function (e) {
    if (e.target.id !== "loginf") return; e.preventDefault();
    var pw = $("#pw").value;
    fetch("api/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (!x.ok) { showLogin(x.j.error || "Не получилось войти"); return; } document.body.classList.remove("locked"); connect(); })
      .catch(function () { showLogin("Нет связи с сервером"); });
  });
  function connect() {
    return fetch("api/state", { credentials: "same-origin", cache: "no-store" }).then(function (r) {
      if (r.status === 401) { SRV = {}; showLogin(); return "login"; }
      if (!r.ok || !/json/.test(r.headers.get("content-type") || "")) return "local";
      return r.json().then(function (j) { SRV = j; boot(); return "server"; });
    }).catch(function () { return "local"; });
  }
  function pull() {
    if (!SRV || !SRV.kv || pending) return;
    fetch("api/state", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (j && j.v !== SRV.v && !pending) { SRV = j; boot(true); }
    }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pull(); });
  window.addEventListener("focus", pull);
  setInterval(function () { if (!document.hidden) pull(); }, 30000);

  function start() {
    document.body.classList.remove("locked");
    (window.VAULT ? Promise.resolve(window.VAULT.data) : fetch("data.json").then(function (r) { return r.json(); })).then(function (j) {
      D = j;
      j.looks.forEach(function (l) { l.key = String(l.id); LOOK[l.key] = l; });
      j.items.forEach(function (x) { ITEM[x.id] = x; });
      S.seed = (Date.now() % 100000) + 7;
      if (/tgWebApp/.test(location.hash + location.search)) {
        var s = document.createElement("script"); s.src = "https://telegram.org/js/telegram-web-app.js";
        s.onload = function () { initTg(); boot(); }; s.onerror = function () { boot(); }; document.head.appendChild(s); return;
      }
      if (window.VAULT) { boot(); return; }
      connect().then(function (mode) { if (mode === "local") boot(); });
    }).catch(function () { $("#app").innerHTML = '<div class="empty" style="margin-top:24px">Не удалось загрузить образы. Обновите страницу.</div>'; });
  }
  if (window.VAULT_MODE) { if (window.__vaultReady) start(); else window.onVaultReady = start; } else start();
})();
