(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      try {
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy failed'));
      } catch (err) {
        document.body.removeChild(ta);
        reject(err);
      }
    });
  }

  ready(function () {
    var blocks = document.querySelectorAll('pre > code');
    blocks.forEach(function (code) {
      var pre = code.parentNode;
      if (!pre || pre.parentNode && pre.parentNode.classList.contains('code-block-wrap')) {
        return;
      }
      var wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-code-btn';
      btn.setAttribute('aria-label', '复制代码');
      btn.textContent = '复制';

      btn.addEventListener('click', function () {
        copyText(code.innerText).then(function () {
          btn.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = '复制';
            btn.classList.remove('copied');
          }, 1500);
        }).catch(function () {
          btn.textContent = '失败';
          setTimeout(function () {
            btn.textContent = '复制';
          }, 1500);
        });
      });

      wrap.insertBefore(btn, pre);
    });
  });
})();
