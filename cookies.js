// Aviso de cookies: Metricool (analítica) solo se carga si el visitante acepta.
// La elección se guarda en este navegador; se puede cambiar con el enlace
// "Configurar cookies" (cualquier elemento con data-cookies).
(function () {
  var CLAVE = 'ria_cookies'; // 'si' | 'no'

  function leer() { try { return localStorage.getItem(CLAVE); } catch (e) { return null; } }
  function guardar(v) { try { localStorage.setItem(CLAVE, v); } catch (e) {} }

  function cargarMetricool() {
    if (window.__metricool) return;
    window.__metricool = true;
    var s = document.createElement('script');
    s.src = 'https://tracker.metricool.com/resources/be.js';
    s.onload = function () { window.beTracker && beTracker.t({ hash: '5ddb235ea7ca9a82f32d4a75fc10b3f0' }); };
    document.head.appendChild(s);
  }

  var css = '' +
    '.ck{position:fixed;left:16px;right:16px;bottom:16px;z-index:50;max-width:560px;margin:0 auto;' +
    'background:#fff;color:#14201C;border:1px solid #E1E5E1;border-radius:16px;box-shadow:0 8px 30px rgba(20,32,28,.15);' +
    'padding:16px 18px;font:14px/1.5 Inter,system-ui,sans-serif;display:flex;flex-direction:column;gap:12px}' +
    '.ck p{margin:0;color:#33403B}.ck a{color:#0F6B5C}' +
    '.ck div{display:flex;gap:10px;flex-wrap:wrap}' +
    '.ck button{min-height:44px;padding:0 18px;border-radius:999px;font:inherit;font-weight:600;cursor:pointer;border:1px solid #0F6B5C}' +
    '.ck .si{background:#0F6B5C;color:#fff}.ck .no{background:#fff;color:#0F6B5C}';

  function mostrar() {
    if (document.getElementById('ck')) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var d = document.createElement('div');
    d.className = 'ck'; d.id = 'ck'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Aviso de cookies');
    d.innerHTML = '<p>Usamos cookies de analítica (Metricool) para saber cuánta gente visita la web y de dónde viene. ' +
      'Solo se activan si aceptas. <a href="aviso-legal.html#cookies">Más información</a>.</p>' +
      '<div><button type="button" class="si">Aceptar</button><button type="button" class="no">Rechazar</button></div>';
    d.querySelector('.si').onclick = function () { guardar('si'); d.remove(); cargarMetricool(); };
    d.querySelector('.no').onclick = function () { guardar('no'); d.remove(); };
    document.body.appendChild(d);
  }

  function iniciar() {
    var v = leer();
    if (v === 'si') cargarMetricool();
    else if (v !== 'no') mostrar();
    document.querySelectorAll('[data-cookies]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); mostrar(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
