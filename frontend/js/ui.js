// Utilidades compartilhadas: tema Tailwind, toasts, barra superior, relógio
if (window.tailwind) {
  tailwind.config = {
    theme: { extend: {
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"] },
      colors: { brand: { 50: "#eff6ff", 100: "#dbeafe", 500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8", 900: "#1e3a8a" } }
    } }
  };
}

window.esc = function (v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
};

window.toast = function (msg, tipo) {
  var box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
  var t = document.createElement("div");
  t.className = "toast " + (tipo || "");
  t.textContent = String(msg).replace(/^[✅❌⚠️]\s*/u, "");
  box.appendChild(t);
  setTimeout(function () { t.classList.add("sai"); setTimeout(function () { t.remove(); }, 320); }, 4200);
};

// alert() antigo vira toast elegante
window.alert = function (msg) {
  var m = String(msg);
  var tipo = /^✅/.test(m) ? "ok" : /^❌|erro|falha/i.test(m) ? "err" : /^⚠️|selecione|informe|nenhum/i.test(m) ? "warn" : "";
  window.toast(m, tipo);
};

document.addEventListener("DOMContentLoaded", function () {
  var tb = document.getElementById("topbar");
  if (!tb) return;
  if (window.self !== window.top) { tb.remove(); return; } // embutido no portal
  var d = tb.dataset;
  tb.className = "sticky top-0 z-30 backdrop-blur-xl bg-white/70 border-b border-white/60 shadow-sm";
  tb.innerHTML =
    '<div class="max-w-5xl mx-auto px-4 h-16 flex items-center gap-3">' +
      '<div class="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white grid place-items-center text-xl shadow-lg">' + (d.icon || "🏥") + '</div>' +
      '<div class="leading-tight"><div class="font-bold text-slate-900">' + esc(d.title) + '</div>' +
      '<div class="text-xs text-slate-500">' + esc(d.sub || "Projeto Sentinela") + '</div></div>' +
      '<div class="ml-auto flex items-center gap-2">' +
        '<span id="relogio" class="hidden sm:block text-sm font-semibold text-slate-600 tabular-nums mr-2"></span>' +
        (d.tv ? '<a href="tv.html" target="_blank" class="px-3 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-br from-cyan-500 to-cyan-700 hover:-translate-y-0.5 transition shadow">📺 TV</a>' : "") +
        '<a href="index.html" class="px-3 py-2 rounded-xl text-sm font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 transition">Sair</a>' +
      '</div></div>';
  var rel = document.getElementById("relogio");
  function tick() { rel.textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
  tick(); setInterval(tick, 30000);
});
