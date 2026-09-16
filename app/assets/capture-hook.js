/*
 * 注入到教务系统课表页的探针脚本（资源路径 assets/capture-hook.js）。
 *
 * 目的：
 *   1. 页面自己发起的请求（XHR / fetch）如果返回 PDF，直接把字节交给原生 ——
 *      这条最重要：正方「输出PDF」很可能是 POST，原生用 GET 重放会拿到错误页。
 *   2. 如果拿不到二进制（responseType 是 text），把 url + method + body 报给原生去重放。
 *   3. 把所有网络请求打到原生日志，方便定位。
 *   4. window.open / target=_blank 重写成当前页打开，让请求经过原生拦截器。
 *
 * 依赖原生注入的 KcbBridge（见 MainActivity 的 WebBridge 内部类）。
 */
(function () {
  'use strict';
  if (window.__kcbHooked) return;
  window.__kcbHooked = true;

  function report(url, note) {
    try {
      if (window.KcbBridge && KcbBridge.onNet) KcbBridge.onNet(String(url), String(note || ''));
    } catch (e) { /* 桥不可用时静默，绝不能影响页面本身 */ }
  }

  function suspect(note) {
    return /pdf|octet-stream/i.test(note || '');
  }

  function bytesToB64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /* 把二进制直接交给原生 */
  function hand(bytes) {
    try {
      if (!bytes || bytes.length < 5) return;
      // 只认 %PDF-
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D)) {
        report('', '拿到了二进制但不是 PDF（' + bytes.length + ' 字节）');
        return;
      }
      if (window.KcbBridge && KcbBridge.onBlob) KcbBridge.onBlob(bytesToB64(bytes), bytes.length);
    } catch (e) { }
  }

  /* 拿不到二进制时，把请求要素报给原生去重放 */
  function replay(url, method, body, contentType) {
    try {
      if (window.KcbBridge && KcbBridge.onPdfUrl) {
        KcbBridge.onPdfUrl(String(url || ''), String(method || 'GET'),
          String(body || ''), String(contentType || ''));
      }
    } catch (e) { }
  }

  /* ---------- fetch ---------- */
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (input && input.url) ? input.url : input;
      var method = (init && init.method) || 'GET';
      var fbody = (init && typeof init.body === 'string') ? init.body : '';
      return origFetch.apply(this, arguments).then(function (resp) {
        var ct = '';
        try { ct = resp.headers.get('content-type') || ''; } catch (e) { }
        report(url, 'fetch ' + method + ' ' + resp.status + ' ' + ct);
        if (suspect(ct)) {
          try {
            resp.clone().arrayBuffer().then(function (b) {
              hand(new Uint8Array(b));
              replay(url, method, fbody, '');
            }, function () { replay(url, method, fbody, ''); });
          } catch (e) { replay(url, method, fbody, ''); }
        }
        return resp;
      });
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__kcbUrl = url;
    this.__kcbMethod = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    xhr.__kcbBody = (typeof body === 'string') ? body : '';
    xhr.addEventListener('load', function () {
      var ct = '';
      try { ct = xhr.getResponseHeader('content-type') || ''; } catch (e) { }
      report(xhr.__kcbUrl, 'xhr ' + xhr.__kcbMethod + ' ' + xhr.status + ' ' + ct);
      if (!suspect(ct)) return;

      // 先试着直接从响应里读二进制
      var got = false;
      try {
        var r = xhr.response;
        if (r instanceof Blob) {
          got = true;
          r.arrayBuffer().then(function (b) { hand(new Uint8Array(b)); });
        } else if (r instanceof ArrayBuffer) {
          got = true;
          hand(new Uint8Array(r));
        }
      } catch (e) { }

      // responseType 是 text 时读不到二进制，交给原生按相同 method+body 重放
      if (!got) replay(xhr.__kcbUrl, xhr.__kcbMethod, xhr.__kcbBody,
        (xhr.getResponseHeader && '') || '');
    });
    return origSend.apply(this, arguments);
  };

  /* ---------- window.open：改成在当前页打开 ----------
     不依赖原生 setSupportMultipleWindows（那个开关会走复杂的新窗口流程，风险高），
     重写成 location.href 后，后续请求照样会经过 shouldInterceptRequest。 */
  var origOpenWin = window.open;
  window.open = function (url) {
    report(url, 'window.open');
    if (url) {
      try { location.href = url; return window; } catch (e) { }
    }
    return origOpenWin.apply(this, arguments);
  };

  /* ---------- target=_blank 的链接改成当前窗口打开 ---------- */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
    if (a && String(a.target || '').toLowerCase() === '_blank') a.target = '_self';
  }, true);

  /* ---------- <a download> / 直接的 .pdf 链接 ---------- */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    if (a.hasAttribute('download') || /\.pdf(\?|#|$)/i.test(a.href)) {
      report(a.href, 'a[download]');
      replay(a.href, 'GET', '', '');
    }
  }, true);

  /* ---------- 隐藏 form 提交到打印接口 ---------- */
  var origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    var action = this.action, method = (this.method || 'get'), q = '';
    try { q = new URLSearchParams(new FormData(this)).toString(); } catch (e) { }
    report(action + '?' + q, 'form.submit ' + method);
    replay(action, method.toUpperCase(), q, 'application/x-www-form-urlencoded');
    return origSubmit.apply(this, arguments);
  };

  /* ---------- 页面本地生成的 PDF（jsPDF / html2canvas 之类） ---------- */
  var origCreate = URL.createObjectURL;
  if (origCreate) {
    URL.createObjectURL = function (blob) {
      var url = origCreate.apply(URL, arguments);
      try {
        if (blob instanceof Blob && (blob.type || '').toLowerCase().indexOf('pdf') >= 0) {
          report(url, 'blob ' + blob.type + ' ' + blob.size);
          blob.arrayBuffer().then(function (buf) { hand(new Uint8Array(buf)); });
        }
      } catch (e) { }
      return url;
    };
  }
})();
