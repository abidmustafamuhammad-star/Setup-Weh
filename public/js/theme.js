/* ReceOTP — Theme toggle logic (shared) */
(function(){
  function applyTheme(t){
    document.documentElement.setAttribute('data-theme', t);
    try{ localStorage.setItem('theme', t); }catch(e){}
  }

  // dipanggil dari tombol toggle (onclick="toggleTheme()")
  window.toggleTheme = function(){
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try{ localStorage.setItem('theme-manual', '1'); }catch(e){}
  };

  // kalau user belum pernah pilih manual, ikuti perubahan preferensi OS secara live
  try{
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e){
      try{ if (localStorage.getItem('theme-manual')) return; }catch(err){}
      applyTheme(e.matches ? 'light' : 'dark');
    });
  }catch(e){}
})();
