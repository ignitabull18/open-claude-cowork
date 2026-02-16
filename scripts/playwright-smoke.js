const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const issues = [];
const logs = [];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();

  const badResponses = [];
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/')) {
      const status = res.status();
      if (status >= 400) {
        badResponses.push({ url, status });
      }
    }
  });

  page.on('pageerror', (error) => {
    issues.push({
      severity: 'high',
      area: 'runtime',
      issue: 'Unhandled page error',
      evidence: error.message
    });
  });

  page.on('console', (msg) => {
    const text = msg.text();
    if (['error', 'warning'].includes(msg.type())) {
      logs.push({ type: msg.type(), text });
    }
  });

  const snap = async (name) => {
    await page.screenshot({ path: `output/playwright/${name}.png`, fullPage: true });
  };

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  } catch (err) {
    issues.push({
      severity: 'blocker',
      area: 'load',
      issue: 'App failed to load',
      evidence: err.message
    });
    await snap('01-load-failed');
    await browser.close();
    console.log(JSON.stringify({ issues, logs }, null, 2));
    return;
  }

  await snap('01-home');

  const homeViewHidden = await page.locator('#homeView').evaluate((el) => el.classList.contains('hidden'));
  const chatViewHidden = await page.locator('#chatView').evaluate((el) => el.classList.contains('hidden'));

  if (!homeViewHidden) {
    const greetingExists = await page.locator('.greeting-text').count();
    if (!greetingExists) {
      issues.push({
        severity: 'medium',
        area: 'home',
        issue: 'Home view shown without greeting heading',
        evidence: 'Expected .greeting-text missing from initial view'
      });
    }
  } else if (!chatViewHidden) {
    issues.push({
      severity: 'low',
      area: 'home',
      issue: 'Chat view visible on first load',
      evidence: '#chatView visible before any user action'
    });
  }

  if (await page.locator('#backendBanner').count()) {
    const bannerText = await page.locator('#backendBanner strong').textContent();
    if (bannerText) {
      issues.push({
        severity: 'medium',
        area: 'backend',
        issue: 'Backend banner is visible on startup',
        evidence: bannerText.trim()
      });
      await page.screenshot({ path: 'output/playwright/02-backend-banner.png', fullPage: true });
    }
  }

  const sendBtnDisabledInitially = await page.locator('#homeSendBtn').isDisabled();
  const inputValueInitially = await page.locator('#homeInput').inputValue();
  if (!sendBtnDisabledInitially || inputValueInitially !== '') {
    issues.push({
      severity: 'low',
      area: 'chat',
      issue: 'Send button should be disabled with empty input',
      evidence: `disabled=${sendBtnDisabledInitially}, input="${inputValueInitially}"`
    });
  }

  await page.fill('#homeInput', 'Integration smoke test message');
  const sendEnabled = (await page.locator('#homeSendBtn').isDisabled()) === false;
  if (!sendEnabled) {
    issues.push({
      severity: 'medium',
      area: 'chat',
      issue: 'Send button does not enable when message typed',
      evidence: 'homeSendBtn remains disabled after entering text'
    });
  }

  await page.click('#homeSendBtn');
  await page.waitForTimeout(2000);
  await snap('03-message-send');

  const anyMessage = await page.locator('.message').first().waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
  if (!anyMessage) {
    issues.push({
      severity: 'high',
      area: 'chat',
      issue: 'No message rendered after clicking send',
      evidence: 'Expected .message elements in chat or home response area'
    });
  } else {
    const msgs = await page.locator('.message .message-content').allTextContents();
    const hasUserText = msgs.some((t) => t.includes('Integration smoke test message'));
    if (!hasUserText) {
      issues.push({
        severity: 'medium',
        area: 'chat',
        issue: 'Sent message not reflected in message list',
        evidence: JSON.stringify(msgs.slice(0, 3))
      });
    }

    const hasAssistantText = msgs.some((t) => t.toLowerCase().includes('message') || t.toLowerCase().includes('error'));
    if (!hasAssistantText) {
      issues.push({
        severity: 'medium',
        area: 'chat',
        issue: 'No assistant reply or error text rendered after send',
        evidence: 'Only user content or no content found'
      });
    }
  }

  const chatVisibleAfterSend = await page.locator('#chatView').evaluate((el) => !el.classList.contains('hidden'));
  if (!chatVisibleAfterSend) {
    issues.push({
      severity: 'medium',
      area: 'chat',
      issue: 'Chat view did not activate after sending first message',
      evidence: '#chatView remained hidden'
    });
  }

  const sideViews = [
    { id: '#reportsSidebarBtn', back: '#reportsBackBtn', name: 'reports' },
    { id: '#jobsSidebarBtn', back: '#jobsBackBtn', name: 'jobs' },
    { id: '#vaultSidebarBtn', back: '#vaultBackBtn', name: 'vault' },
    { id: '#tasksSidebarBtn', back: '#tasksNewBtn', name: 'tasks' },
    { id: '#settingsSidebarBtn', back: '#settingsBackBtn', name: 'settings' }
  ];

  for (const view of sideViews) {
    const btn = page.locator(view.id);
    const visible = await btn.count() > 0 && await btn.isVisible();
    if (!visible) {
      issues.push({
        severity: 'low',
        area: view.name,
        issue: `${view.name} button not visible`,
        evidence: `${view.id} missing or hidden`
      });
      continue;
    }

    await btn.click();
    await page.waitForTimeout(700);

    if (view.name === 'jobs') {
      const unavailable = await page.locator('#jobsUnavailable').isVisible().catch(() => false);
      if (unavailable) {
        issues.push({
          severity: 'medium',
          area: 'jobs',
          issue: 'Jobs API appears unavailable for this environment',
          evidence: 'jobsUnavailable state shown'
        });
      }
    }

    if (view.name === 'vault') {
      const unavailable = await page.locator('#vaultUnavailable').isVisible().catch(() => false);
      if (unavailable) {
        issues.push({
          severity: 'low',
          area: 'vault',
          issue: 'Vault API requires Supabase and is unavailable in this environment',
          evidence: 'vaultUnavailable state shown'
        });
      }
    }

    if (view.name === 'tasks') {
      const addTask = await page.locator('#tasksNewBtn').isVisible().catch(() => false);
      if (!addTask) {
        issues.push({
          severity: 'low',
          area: 'tasks',
          issue: 'Task creation button not available',
          evidence: '#tasksNewBtn missing'
        });
      }
    }

    const hasSettings = view.name === 'settings';
    if (hasSettings) {
      const hasProviderDropdown = await page.locator('.settings-view .provider-selector').count();
      if (!hasProviderDropdown) {
        issues.push({
          severity: 'low',
          area: 'settings',
          issue: 'Settings view loaded but core controls missing',
          evidence: 'settings provider selector not found'
        });
      }
    }

    const backLocator = page.locator(view.back);
    const backVisible = await backLocator.count() > 0;
    if (backVisible) {
      await backLocator.click();
      await page.waitForTimeout(500);
      await snap(`04-${view.name}-back`);
    } else {
      await page.keyboard.press('Escape');
      issues.push({
        severity: 'low',
        area: view.name,
        issue: `Could not return from ${view.name} view`,
        evidence: `${view.back} missing`
      });
    }
  }

  const reportsBtn = page.locator('#reportsSidebarBtn');
  if (await reportsBtn.count()) {
    await page.locator('#reportsSidebarBtn').click();
    await page.waitForTimeout(500);
    await page.click('#reportsBackBtn');
    await page.waitForTimeout(300);
  }

  const leftToggle = page.locator('#leftSidebarToggle');
  if (await leftToggle.count()) {
    await leftToggle.click();
    await page.waitForTimeout(300);
    await page.locator('#leftSidebarExpand').click();
    await page.waitForTimeout(300);
    await snap('05-sidebar-toggle');
  }

  await page.locator('#homeProviderDropdown .provider-selector').click();
  const claudeOption = page.locator('#homeProviderDropdown .provider-menu .dropdown-item[data-value="claude"]');
  const opencodeOption = page.locator('#homeProviderDropdown .provider-menu .dropdown-item[data-value="opencode"]');
  if (!(await claudeOption.count()) || !(await opencodeOption.count())) {
    issues.push({
      severity: 'low',
      area: 'chat controls',
      issue: 'Provider dropdown missing expected options',
      evidence: `claude=${await claudeOption.count()}, opencode=${await opencodeOption.count()}`
    });
  }
  await page.click('body', { position: { x: 0, y: 0 } });

  if (badResponses.length) {
    const top = badResponses.slice(0, 12);
    issues.push({
      severity: 'medium',
      area: 'api',
      issue: 'Backend API returned errors',
      evidence: JSON.stringify(top)
    });
  }

  const finalModelLabel = await page.locator('#homeModelDropdown .model-label').first().textContent();
  if (!finalModelLabel || !finalModelLabel.trim()) {
    issues.push({
      severity: 'low',
      area: 'chat controls',
      issue: 'Model label missing',
      evidence: 'No text in home model label button'
    });
  }

  await snap('06-final');
  await browser.close();

  const summary = {
    runAt: new Date().toISOString(),
    totalIssues: issues.length,
    issues,
    badApiResponses: badResponses,
    consoleWarnings: logs
  };
  console.log(JSON.stringify(summary, null, 2));
}

run().catch(async (err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
