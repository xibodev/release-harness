document.addEventListener('DOMContentLoaded', () => {
  // Terminal Simulations
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
    'doctor': [
      '<span class="t-cyan">$ npx release-harness doctor</span>',
      '<span class="t-bold">Release-Harness v1.0.0 Diagnostics & Prerequisites</span>',
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
    'init': [
      '<span class="t-cyan">$ npx release-harness init</span>',
      'Scaffolding project-owned Release-Harness configuration under .release-harness...',
      '',
      '  <span class="t-green">✓</span> Created .release-harness/harness.config.json',
      '  <span class="t-green">✓</span> Created .release-harness/topology.json',
      '  <span class="t-green">✓</span> Created .release-harness/origins.json',
      '  <span class="t-green">✓</span> Created .release-harness/scenarios/smoke.json',
      '  <span class="t-green">✓</span> Created .release-harness/README.md',
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
  const termBtns = document.querySelectorAll('.term-btn');

  function renderTerminal(cmdKey) {
    if (!termBody) return;
    const lines = terminalOutputs[cmdKey] || [];
    termBody.innerHTML = lines.join('\n');
  }

  termBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      termBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const cmd = btn.getAttribute('data-cmd');
      renderTerminal(cmd);
    });
  });

  // Initial terminal render
  renderTerminal('run-local');

  // Generic Tabs switching
  document.querySelectorAll('.tab-container').forEach(container => {
    const btns = container.querySelectorAll('.tab-btn');
    const panes = container.querySelectorAll('.tab-pane');

    btns.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        panes.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        if (panes[idx]) panes[idx].classList.add('active');
      });
    });
  });

  // Copy buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const targetEl = targetId ? document.getElementById(targetId) : btn.parentElement.nextElementSibling;
      const textToCopy = targetEl ? targetEl.innerText.trim() : '';

      navigator.clipboard.writeText(textToCopy).then(() => {
        const orig = btn.innerText;
        btn.innerText = 'COPIED!';
        setTimeout(() => btn.innerText = orig, 1800);
      });
    });
  });

  // Active scrollspy for sidebar
  const sections = document.querySelectorAll('section[id], h2[id]');
  const navLinks = document.querySelectorAll('.nav-link');

  window.addEventListener('scroll', () => {
    let current = '';
    sections.forEach(section => {
      const sectionTop = section.offsetTop - 140;
      if (window.scrollY >= sectionTop) {
        current = section.getAttribute('id');
      }
    });

    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === `#${current}`) {
        link.classList.add('active');
      }
    });
  });
});
