(() => {
  const root = document.documentElement;
  const choices = ['system', 'light', 'dark', 'studio'];
  let theme = 'system';
  try { const saved = localStorage.getItem('audivane-site-theme'); if (choices.includes(saved)) theme = saved; } catch {}
  root.dataset.theme = theme;
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.querySelector('#site-theme');
    if (!picker) return;
    picker.value = theme;
    picker.addEventListener('change', () => {
      root.dataset.theme = picker.value;
      try { localStorage.setItem('audivane-site-theme', picker.value); } catch {}
    });
  });
})();