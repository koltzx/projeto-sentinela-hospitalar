// Atalho global para abrir o painel de administração: Ctrl + Shift + 5
document.addEventListener("keydown", function (e) {
  var tecla5 = e.code === "Digit5" || e.code === "Numpad5" || e.key === "5" || e.key === "%";
  if (!(e.ctrlKey && e.shiftKey && !e.altKey && tecla5)) return;

  e.preventDefault();
  var w = window.top || window;
  if (w.location.pathname.indexOf("admin.html") === -1) {
    w.location.href = "/admin.html";
  }
}, true);
