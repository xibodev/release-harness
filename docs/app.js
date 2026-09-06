document.addEventListener('DOMContentLoaded', () => {
  const themeButton = document.getElementById('theme-toggle-btn');
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (themeButton) {
      themeButton.textContent = theme === 'dark' ? 'LIGHT' : 'DARK';
      themeButton.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    }
    try { localStorage.setItem('rh_theme', theme); } catch (_) { /* Storage is optional. */ }
  }
  let savedTheme;
  try { savedTheme = localStorage.getItem('rh_theme'); } catch (_) { /* Use the default theme. */ }
  applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
  themeButton?.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  const contentsButton = document.getElementById('contents-toggle');
  const navigation = document.getElementById('docs-navigation');
  const mobile = window.matchMedia('(max-width: 900px)');
  function setContents(open) {
    if (!navigation || !contentsButton) return;
    navigation.hidden = mobile.matches && !open;
    contentsButton.setAttribute('aria-expanded', String(!navigation.hidden));
  }
  if (contentsButton) {
    contentsButton.hidden = false;
    setContents(false);
    contentsButton.addEventListener('click', () => setContents(navigation.hidden));
    mobile.addEventListener('change', () => setContents(false));
  }

  const search = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const status = document.getElementById('search-status');
  const sections = [...document.querySelectorAll('.content > section[id]')];
  // Index text once; searching never hides the document or breaks deep links.
  const index = sections.map(section => ({
    id: section.id,
    title: section.querySelector('h2').textContent,
    text: section.textContent.toLowerCase(),
  }));
  search?.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    results.replaceChildren();
    results.hidden = !query;
    status.textContent = '';
    if (!query) return;
    const matches = index.filter(item => item.text.includes(query));
    for (const match of matches) {
      const link = document.createElement('a');
      link.href = `#${match.id}`;
      link.className = 'nav-link';
      link.textContent = match.title;
      const item = document.createElement('li');
      item.append(link);
      results.append(item);
    }
    status.textContent = matches.length ? `${matches.length} matching section${matches.length === 1 ? '' : 's'}` : 'No matching sections. Try a command or contract name.';
  });
  window.addEventListener('keydown', event => {
    if (!search) return;
    const editing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]');
    if (event.key === 'Escape' && mobile.matches && !navigation.hidden) {
      setContents(false);
      contentsButton.focus();
    } else if (!editing && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
      event.preventDefault();
      setContents(true);
      search.focus();
    }
  });

  document.querySelectorAll('.copy-btn').forEach(button => {
    const label = button.parentElement.querySelector('span')?.textContent || 'code';
    button.setAttribute('aria-label', `Copy ${label}`);
    button.addEventListener('click', async () => {
      const code = button.parentElement.nextElementSibling;
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        button.textContent = 'COPIED';
      } catch (_) {
        button.textContent = 'SELECT CODE';
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      window.setTimeout(() => { button.textContent = 'COPY'; }, 1800);
    });
  });

  const navLinks = [...document.querySelectorAll('.documentation-nav .nav-link')];
  function markActive(id) {
    navLinks.forEach(link => {
      const active = link.hash === `#${id}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  function followHash() {
    const target = document.getElementById(location.hash.slice(1));
    if (!target) return;
    const section = target.closest('section');
    if (section) markActive(section.id);
  }
  navigation?.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const target = document.getElementById(link.hash.slice(1));
    setContents(false);
    if (target && mobile.matches) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  });
  window.addEventListener('hashchange', followHash);
  followHash();
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.find(entry => entry.isIntersecting);
      if (visible) markActive(visible.target.id);
    }, { rootMargin: '-8% 0px -70% 0px' });
    sections.forEach(section => observer.observe(section));
  }
  document.querySelectorAll('pre, .tech-table').forEach(element => {
    element.tabIndex = 0;
    if (element.tagName === 'PRE') element.setAttribute('aria-label', element.previousElementSibling?.classList.contains('code-header') ? element.previousElementSibling.querySelector('span').textContent : 'Code example');
  });
});
