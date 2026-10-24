/* Капсула · личный режим: всё содержимое зашифровано (AES-256-GCM).
   Ключ содержимого хранится в k.json, зашифрованный паролем владелицы (PBKDF2-SHA256, 600 000 итераций).
   После ввода пароля ключ запоминается на этом устройстве. */
(function () {
  "use strict";
  window.VAULT_MODE = true;
  var LS = "kap_vault_k", ITER = 600000, enc = new TextEncoder(), dec = new TextDecoder();
  var subtle = window.crypto && window.crypto.subtle;
  function $(s) { return document.querySelector(s); }
  function b64(u8) { var s = ""; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function unb64(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function store(k) { try { if (k) localStorage.setItem(LS, b64(k)); else localStorage.removeItem(LS); } catch (e) {} }
  function stored() { try { var v = localStorage.getItem(LS); return v ? unb64(v) : null; } catch (e) { return null; } }
  function aesKey(raw) { return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]); }
  function kek(pw, salt) {
    return subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (b) {
      return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: ITER }, b, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function fetchBin(name) { return fetch(name + ".bin", { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("нет файла " + name + ".bin"); return r.arrayBuffer(); }); }
  function open(key, name, buf) {
    var u = new Uint8Array(buf);
    return subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12), additionalData: enc.encode(name) }, key, u.slice(12)).then(function (p) {
      var v = new DataView(p), n = v.getUint32(0), idx = JSON.parse(dec.decode(new Uint8Array(p, 4, n)));
      return { idx: idx, body: p.slice(4 + n) };
    });
  }

  /* ---------- unlocked: expose assets to the app ---------- */
  var urls = {}, parts = {};
  function url(path) {
    if (urls[path]) return urls[path];
    for (var k in parts) {
      var e = parts[k].idx[path];
      if (e) return (urls[path] = URL.createObjectURL(new Blob([parts[k].body.slice(e[0], e[0] + e[1])], { type: e[2] })));
    }
    return path;
  }
  function unlock(raw, dataPart) {
    status("Открываю гардероб…");
    return aesKey(raw).then(function (key) {
      var first = dataPart ? Promise.resolve(dataPart) : fetchBin("d").then(function (b) { return open(key, "d", b); });
      return Promise.all([first].concat(["i", "b", "s"].map(function (n) { return fetchBin(n).then(function (b) { return open(key, n, b); }); })));
    }).then(function (ps) {
      parts = { d: ps[0], i: ps[1], b: ps[2], s: ps[3] };
      var e = parts.d.idx["data.json"];
      window.VAULT = {
        data: JSON.parse(dec.decode(new Uint8Array(parts.d.body, e[0], e[1]))),
        url: url,
        lock: function () { store(null); location.reload(); }
      };
      store(raw);
      if (window.onVaultReady) window.onVaultReady(); else window.__vaultReady = true;
    });
  }

  /* ---------- screens ---------- */
  var HANGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.5a2 2 0 1 1 2 2c-1 0-2 .6-2 1.6v.4"/><path d="M12 9.5 3.2 15.6c-.8.6-.4 1.6.5 1.6h16.6c.9 0 1.3-1 .5-1.6z"/></svg>';
  function screen(inner) {
    document.body.classList.add("locked");
    $("#app").innerHTML = '<div class="login"><div class="logo">' + HANGER + "</div><h1>Капсула</h1>" + inner + "</div>";
  }
  function status(t) { var s = $("#vstatus"); if (s) s.textContent = t; else screen('<p class="foot" id="vstatus">' + t + "</p>"); }
  function err(t) { var e = $("#verr"); if (e) { e.textContent = t; e.hidden = false; } }
  function busy(on, label) { var b = $("#vbtn"); if (b) { b.disabled = on; b.textContent = on ? label : b.dataset.label; } }

  function askPassword() {
    screen('<p class="foot">Личный гардероб. Введите пароль — на этом устройстве он понадобится один раз.</p>' +
      '<form id="vform" class="group"><div class="row"><input id="vpw" class="field" type="password" autocomplete="current-password" placeholder="Пароль" required></div></form>' +
      '<p class="foot err" id="verr" hidden></p><button id="vbtn" data-label="Открыть" type="submit" form="vform" class="btn fill">Открыть</button>');
    setTimeout(function () { var p = $("#vpw"); if (p) p.focus(); }, 50);
    $("#vform").onsubmit = function (e) {
      e.preventDefault(); busy(true, "Проверяю…");
      var pw = $("#vpw").value;
      fetch("k.json", { cache: "no-cache" }).then(function (r) {
        if (!r.ok) throw new Error("nok");
        return r.json();
      }).then(function (k) {
        return kek(pw, unb64(k.salt)).then(function (w) { return subtle.decrypt({ name: "AES-GCM", iv: unb64(k.iv) }, w, unb64(k.ct)); });
      }).then(function (raw) { return unlock(new Uint8Array(raw)); })
        .catch(function (e) { busy(false); err(e && e.message === "nok" ? "Пароль ещё не задан. Откройте ссылку первой настройки." : "Неверный пароль"); });
    };
  }

  function setup(raw) {
    // first run (or password change): the content key arrives in the link's #fragment, which never leaves the device
    status("Проверяю ссылку…");
    aesKey(raw).then(function (key) { return fetchBin("d").then(function (b) { return open(key, "d", b); }); }).then(function (dpart) {
      screen('<p class="foot">Придумайте пароль. Он нужен, чтобы открывать гардероб на других устройствах. Не меньше 8 символов.</p>' +
        '<form id="vform" class="group"><div class="row"><input id="vpw" class="field" type="password" autocomplete="new-password" placeholder="Новый пароль" required minlength="8"></div>' +
        '<div class="row"><input id="vpw2" class="field" type="password" autocomplete="new-password" placeholder="Ещё раз" required minlength="8"></div></form>' +
        '<p class="foot err" id="verr" hidden></p><button id="vbtn" data-label="Создать ключ" type="submit" form="vform" class="btn fill">Создать ключ</button>');
      $("#vform").onsubmit = function (e) {
        e.preventDefault();
        var a = $("#vpw").value, b = $("#vpw2").value;
        if (a.length < 8) return err("Нужно хотя бы 8 символов");
        if (a !== b) return err("Пароли не совпадают");
        busy(true, "Шифрую…");
        var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
        kek(a, salt).then(function (w) { return subtle.encrypt({ name: "AES-GCM", iv: iv }, w, raw); }).then(function (ct) {
          var json = JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) });
          try { history.replaceState(null, "", location.pathname + location.search); } catch (e2) {}
          store(raw);
          var blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
          screen('<p class="foot">Готово. Последний шаг: загрузите этот файл в репозиторий на GitHub рядом с index.html (Add file → Upload files). Через минуту пароль заработает на всех устройствах.</p>' +
            '<a class="btn fill" href="' + blobUrl + '" download="k.json">Скачать k.json</a>' +
            '<div class="group"><div class="row"><textarea class="field" readonly style="min-height:96px;font:12px/16px ui-monospace,monospace">' + json + '</textarea></div></div>' +
            '<p class="foot">Если скачивание не сработало: на GitHub нажмите Add file → Create new file, назовите k.json и вставьте текст выше.</p>' +
            '<button id="vgo" class="btn gray" type="button">Открыть гардероб</button>');
          $("#vgo").onclick = function () { unlock(raw, dpart).catch(fail); };
        });
      };
    }).catch(function () { screen('<p class="foot err">Ссылка настройки не подходит к этим файлам.</p>'); });
  }
  function fail(e) {
    store(null);
    screen('<p class="foot err">Не получилось открыть: ' + (e && e.message ? e.message : "ошибка") + '</p><button class="btn gray" type="button" onclick="location.reload()">Ещё раз</button>');
  }

  function boot() {
    if (!subtle) { screen('<p class="foot err">Этот браузер не умеет расшифровывать. Откройте в Safari или Telegram.</p>'); return; }
    var m = /[#&]setup=([A-Za-z0-9_-]{40,})/.exec(location.hash);
    if (m) return setup(unb64(m[1]));
    var k = stored();
    if (k) return unlock(k).catch(function () { store(null); askPassword(); });
    askPassword();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
