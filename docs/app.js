document.addEventListener('DOMContentLoaded', () => {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const storageKey = 'rh_theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (themeToggleBtn) {
      const nextLabel = theme === 'dark' ? 'LIGHT' : 'DARK';
      themeToggleBtn.textContent = nextLabel;
      themeToggleBtn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    }
    try { localStorage.setItem(storageKey, theme); } catch (_) { /* Storage may be unavailable. */ }
  }

  let savedTheme;
  try { savedTheme = localStorage.getItem(storageKey); } catch (_) { savedTheme = null; }
  applyTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'light');
  themeToggleBtn?.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  const searchInput = document.getElementById('search-input');
  const searchableItems = document.querySelectorAll('main section[id], .tech-card, .tech-table tbody tr');
  function runSearch() {
    const query = searchInput?.value.toLowerCase().trim() || '';
    searchableItems.forEach((element) => {
      element.hidden = Boolean(query) && !element.innerText.toLowerCase().includes(query);
    });
  }
  searchInput?.addEventListener('input', runSearch);
  window.addEventListener('keydown', (event) => {
    const shortcut = event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k');
    if (shortcut && searchInput && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  document.querySelectorAll('.copy-btn').forEach((button) => {
    button.setAttribute('aria-label', 'Copy code to clipboard');
    button.addEventListener('click', async () => {
      const target = button.dataset.target
        ? document.getElementById(button.dataset.target)
        : button.parentElement?.nextElementSibling;
      if (!target) return;
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(target.innerText.trim());
        button.textContent = 'COPIED';
      } catch (_) {
        button.textContent = 'COPY FAILED';
      }
      window.setTimeout(() => { button.textContent = original; }, 1800);
    });
  });

  const navLinks = [...document.querySelectorAll('.nav-link[href^="#"]')];
  const sections = [...document.querySelectorAll('main section[id]')];
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => {
        link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`);
      });
    }, { rootMargin: '-12% 0px -75% 0px', threshold: [0, .2, .5] });
    sections.forEach((section) => observer.observe(section));
  }
});
