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
  // Light is the default. A visitor's OS preference does not choose for them —
  // only their own explicit toggle, remembered across visits, does.
  applyTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'light');
  themeToggleBtn?.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  const searchInput = document.getElementById('search-input');
  const searchableItems = document.querySelectorAll('section[id], .skill-item, .tech-card, .tech-table tbody tr');
  function runSearch() {
    const query = searchInput?.value.toLowerCase().trim() || '';
    searchableItems.forEach((element) => {
      element.hidden = Boolean(query) && !element.innerText.toLowerCase().includes(query);
    });
  }
  searchInput?.addEventListener('input', runSearch);
  window.addEventListener('keydown', (event) => {
    const isShortcut = event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k');
    if (isShortcut && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    }
  });

  const terminalOutputs = {
    'run-local': [
      '<span class="t-cyan">$ npx release-harness run-local</span>',
      '<span class="t-muted">=== Level 2: Local Release UAT Gate [Run: run-2026-prod-01] ===</span>',
      '1. Materializing detached source workspace...',
      '   Source SHA: <span class="t-bold">9f8e7d6c5b4a</span> (clean)',
      '2. Loaded 3 declarative scenario(s)',
      '3. Standing up isolated Docker Compose stack (docker-compose.test.yml)...',
      '   Containers started (Captured 2 OCI artifact digests)',
      '4. Probing service healthchecks...',
      '   <span class="t-green">✓</span> web-frontend (HTTP 200 in 14ms)',
      '   <span class="t-green">✓</span> api-server (HTTP 200 in 8ms)',
      '5. Executing declarative scenarios with Playwright & origin routing...',
      '   <span class="t-green">✓</span> [SMOKE-001] User onboarding flow → http://127.0.0.1:3000 (840ms)',
      '   <span class="t-green">✓</span> [AUTH-002] Passkey auth challenge → http://127.0.0.1:3000 (1220ms)',
      '   <span class="t-green">✓</span> [SEC-003] Negative control fake webcam rejection → http://127.0.0.1:3000 (430ms)',
      '6. Verifying out-of-band side-effects...',
      '   <span class="t-green">✓</span> MinIO S3 object "kyc-docs/passport.webp" verified',
      '7. Sealing evidence directory...',
      '   Evidence sealed (Manifest SHA: <span class="t-cyan">a02360ad1b5c...</span>)',
      '8. Evaluating deterministic gate verdict...',
      '',
      '<span class="t-green t-bold">=== Verdict: PASS (Integrity: COMPLETE, Exit: 0) ===</span>',
      'Summary: Passed: 3, Failed: 0, Unproven: 0, Skipped: 0'
    ],
    doctor: [
      '<span class="t-cyan">$ npx release-harness doctor</span>',
      '<span class="t-bold">Release-Harness v1.0.1 Diagnostics & Prerequisites</span>',
      '',
      'Host Toolchain:',
      '  <span class="t-green">✓</span> Node.js          : 22.14.0',
      '  <span class="t-green">✓</span> Git              : git version 2.47.1',
      '  <span class="t-green">✓</span> Docker Engine    : Docker version 27.2.0',
      '  <span class="t-green">✓</span> Docker Compose   : Docker Compose version v2.29.2',
      '  <span class="t-green">✓</span> Chromium Browser : installed in ms-playwright cache',
      '',
      'Project Contract Discovery:',
      '  <span class="t-green">✓</span> topology.json    : valid (my-project, monorepo)',
      '  <span class="t-green">✓</span> origins.json     : valid (2 origins declared)',
      '  <span class="t-green">✓</span> scenarios/       : 3 scenario file(s) discovered',
      '',
      '<span class="t-green t-bold">Status: Ready.</span>'
    ],
    init: [
      '<span class="t-cyan">$ npx release-harness init</span>',
      'Scaffolding project-owned Release-Harness contracts and multi-runtime AI agents...',
      '',
      '  <span class="t-green">✓</span> Created .release-harness/harness.config.json',
      '  <span class="t-green">✓</span> Created .release-harness/topology.json',
      '  <span class="t-green">✓</span> Created .release-harness/origins.json',
      '  <span class="t-green">✓</span> Created .release-harness/scenarios/smoke.json',
      '  <span class="t-green">✓</span> Created .release-harness/README.md',
      '  <span class="t-green">✓</span> Scaffolding AGENTS.md and .cursorrules',
      '  <span class="t-green">✓</span> Scaffolding Claude Code agent & 17 skills (.claude/)',
      '  <span class="t-green">✓</span> Scaffolding opencode agent & 17 skills (.opencode/)',
      '  <span class="t-green">✓</span> Scaffolding GitHub Copilot agent & instructions (.github/)',
      '',
      '<span class="t-green t-bold">Initialization complete. Run "npx release-harness doctor" to verify.</span>'
    ],
    'check-pr': [
      '<span class="t-cyan">$ npx release-harness check-pr</span>',
      '=== Level 1: PR Integration Gate ===',
      '<span class="t-green">✓</span> Topology valid (my-project, monorepo)',
      '<span class="t-green">✓</span> Origins contract valid (2 origins defined)',
      '<span class="t-green">✓</span> Toolchain detected: Node 22, Git 2.47, Docker 27.2',
      '<span class="t-green">✓</span> Source Git SHA: 9f8e7d6c5b4a (clean)',
      '',
      '<span class="t-green t-bold">Level 1 Gate: PASS</span>'
    ]
  };

  const termBody = document.getElementById('terminal-body');
  const termBtns = [...document.querySelectorAll('.term-btn')];
  function renderTerminal(command) {
    if (!termBody) return;
    termBody.innerHTML = (terminalOutputs[command] || []).join('\n');
  }
  function setTerminal(button) {
    termBtns.forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    renderTerminal(button.dataset.cmd);
  }
  termBtns.forEach((button, index) => {
    button.addEventListener('click', () => setTerminal(button));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? termBtns[0] : event.key === 'End' ? termBtns.at(-1) : termBtns[(index + (event.key === 'ArrowRight' ? 1 : -1) + termBtns.length) % termBtns.length];
      target.focus();
      setTerminal(target);
    });
  });
  if (termBtns[0]) setTerminal(termBtns[0]);

  document.querySelectorAll('.tab-container').forEach((container) => {
    const buttons = [...container.querySelectorAll('.tab-btn')];
    const panes = [...container.querySelectorAll('.tab-pane')];
    function selectTab(button) {
      const index = buttons.indexOf(button);
      buttons.forEach((item, itemIndex) => {
        const selected = itemIndex === index;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        panes[itemIndex]?.classList.toggle('active', selected);
        if (panes[itemIndex]) panes[itemIndex].hidden = !selected;
      });
    }
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => selectTab(button));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const target = event.key === 'Home' ? buttons[0] : event.key === 'End' ? buttons.at(-1) : buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
        target.focus();
        selectTab(target);
      });
    });
    if (buttons[0]) selectTab(buttons[0]);
  });

  document.querySelectorAll('.skill-header').forEach((header) => {
    const toggle = () => {
      const item = header.parentElement;
      const isOpen = item.classList.toggle('open');
      header.setAttribute('aria-expanded', String(isOpen));
      const content = document.getElementById(header.getAttribute('aria-controls'));
      if (content) content.hidden = !isOpen;
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
  });

  async function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  document.querySelectorAll('.copy-btn').forEach((button) => {
    button.type = 'button';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    button.addEventListener('click', async () => {
      const target = button.dataset.target ? document.getElementById(button.dataset.target) : button.parentElement.nextElementSibling;
      if (!target) return;
      const original = button.textContent;
      try {
        await copyText(target.innerText.trim());
        button.textContent = 'COPIED!';
      } catch (_) {
        button.textContent = 'COPY FAILED';
      }
      window.setTimeout(() => { button.textContent = original; }, 1800);
    });
  });

  const navLinks = [...document.querySelectorAll('.nav-link[href^="#"]')];
  const sections = [...document.querySelectorAll('section[id]')];
  function markActive(id) {
    navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${id}`));
  }
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) markActive(visible.target.id);
  }, { rootMargin: '-12% 0px -75% 0px', threshold: [0, .2, .5] });
  sections.forEach((section) => observer.observe(section));
});