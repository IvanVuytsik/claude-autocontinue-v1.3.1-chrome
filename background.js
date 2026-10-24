const POLL_MS = 6000;

const tabPending = {};

chrome.alarms.create('pollClaudeTabs', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { pollTick(); });

let intervalId = null;

function pollTick() {
  pollAllClaudeTabs().catch((error) => {
    console.error('[AutoContinue] Background poll failed:', error);
  });
}

function startPolling() {
  if (intervalId) return;
  intervalId = setInterval(pollTick, POLL_MS);
}

chrome.runtime.onStartup.addListener(() => startPolling());
chrome.runtime.onInstalled.addListener(() => startPolling());

async function pollAllClaudeTabs() {
  const { paused, maxContinues } = await getSettings();
  if (paused) return;

  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });

  for (const tab of tabs) {
    if (tabPending[tab.id]) continue;

    const { continueCount } = await getSettings();
    if (maxContinues > 0 && continueCount >= maxContinues) continue;

    tabPending[tab.id] = true;

    let detected = null;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detectLimitMessage,
      });
      detected = r?.result;
    } catch {
      tabPending[tab.id] = false;
      continue;
    }

    if (detected !== 'retry' && detected !== 'continue') {
      tabPending[tab.id] = false;
      continue;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'bgTakeover' }).catch(() => {});

    try {
      await runContinueFlow(tab.id);

      const fresh = await getSettings();
      const newCount = fresh.continueCount + 1;
      await chrome.storage.local.set({ continueCount: newCount });

      chrome.tabs.sendMessage(tab.id, {
        type: 'backgroundContinued',
        count: newCount,
        max: fresh.maxContinues,
      }).catch(() => {});

    } catch (e) {
      console.warn('[AutoContinue] tab', tab.id, 'failed:', e.message);
    } finally {
      tabPending[tab.id] = false;
    }
  }
}

function detectLimitMessage() {
  const dialogs = [...document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]'
  )].filter(el =>
    el.getClientRects().length > 0 &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden'
  );

  if (dialogs.length) {
    for (const dialog of dialogs) {
      const closeButton = [...dialog.querySelectorAll(
        'button, [role="button"], [aria-label], [title]'
      )].find(el => {
        const label = (
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.innerText ||
          el.textContent ||
          ''
        ).trim();
        return /^(close|dismiss|got it|done|hide|not now|no thanks|maybe later|later|skip)\b/i.test(label) &&
          !el.disabled &&
          el.getAttribute('aria-disabled') !== 'true' &&
          el.getClientRects().length > 0 &&
          getComputedStyle(el).display !== 'none' &&
          getComputedStyle(el).visibility !== 'hidden';
      });

      if (closeButton) {
        closeButton.click();
      } else if (dialog instanceof HTMLDialogElement && dialog.open) {
        dialog.close();
      } else {
        dialog.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
        }));
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
        }));
      }
    }
    return 'dismissed';
  }

  const getActionType = (el) => {
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.innerText ||
      el.textContent ||
      ''
    ).trim();
    const match = label.match(/^(retry|continue)[.!…]?$/i);
    return match ? match[1].toLowerCase() : null;
  };

  const visible = (el) =>
    !!el && el.getClientRects().length > 0 &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden';

  const candidates = [...document.querySelectorAll(
    'button, [role="button"], a[href], [role="link"], [tabindex], [onclick]'
  )].filter(el =>
    !el.disabled &&
    el.getAttribute('aria-disabled') !== 'true' &&
    visible(el) &&
    getActionType(el)
  );
  const retry = candidates.filter(el => getActionType(el) === 'retry');
  return retry.length ? 'retry' : candidates.length ? 'continue' : null;
}

function clickOrSendContinue() {
  const dialogs = [...document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]'
  )].filter(el =>
    el.getClientRects().length > 0 &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden'
  );
  if (dialogs.length) return false;

  const getActionType = (el) => {
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.innerText ||
      el.textContent ||
      ''
    ).trim();
    const match = label.match(/^(retry|continue)[.!…]?$/i);
    return match ? match[1].toLowerCase() : null;
  };

  const candidates = [...document.querySelectorAll(
    'button, [role="button"], a[href], [role="link"], [tabindex], [onclick]'
  )].filter(el =>
    !el.disabled &&
    el.getAttribute('aria-disabled') !== 'true' &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden' &&
    getActionType(el)
  );
  if (candidates.length) {
    const retry = candidates.filter(el => getActionType(el) === 'retry');
    const pool = retry.length ? retry : candidates;
    const btn = pool[pool.length - 1];
    btn.click();
    return true;
  }

  const input =
    document.querySelector('div[contenteditable="true"][data-placeholder]') ||
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('textarea[placeholder]') ||
    document.querySelector('div[contenteditable="true"]');
  if (!input) return false;

  const currentText = input.isContentEditable
    ? input.innerText || input.textContent || ''
    : input.value || '';
  if (currentText.trim()) return false;

  input.focus();
  if (input.isContentEditable) {
    document.execCommand('insertText', false, 'Continue');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value'
    )?.set;
    if (!valueSetter) return false;
    valueSetter.call(input, 'Continue');
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: 'Continue',
    }));
  }

  const sendButton = [...document.querySelectorAll('button, [role="button"]')]
    .find((el) => {
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.innerText ||
        el.textContent ||
        ''
      ).toLowerCase();
      return (label.includes('send') || label.includes('submit')) &&
        !el.disabled &&
        el.getAttribute('aria-disabled') !== 'true';
    });
  if (sendButton) {
    sendButton.click();
    return true;
  }

  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
  }));
  return true;
}

async function runContinueFlow(tabId) {
  await sleep(1200);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: clickOrSendContinue,
  });
  if (result?.result !== true) {
    throw new Error('Retry or Continue control was no longer available or enabled');
  }
}

async function getSettings() {
  const d = await chrome.storage.local.get([
    'paused', 'maxContinues', 'continueCount',
  ]);
  return {
    paused:         d.paused         ?? false,
    maxContinues:   d.maxContinues   ?? 20,   // 0 means unlimited
    continueCount:  d.continueCount  ?? 0,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'reset') {
    Object.keys(tabPending).forEach(k => delete tabPending[k]);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getSettings') {
    getSettings().then(sendResponse).catch((error) => {
      console.error('[AutoContinue] Could not read settings:', error);
      sendResponse({ error: error.message });
    });
    return true;
  }

  if (msg.type === 'incrementContinueCount') {
    getSettings().then(async (settings) => {
      const continueCount = settings.continueCount + 1;
      await chrome.storage.local.set({ continueCount });
      sendResponse({
        continueCount,
        maxContinues: settings.maxContinues,
      });
    }).catch((error) => {
      console.error('[AutoContinue] Could not save continuation count:', error);
      sendResponse({ error: error.message });
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabPending[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete tabPending[tabId];
  } else if (changeInfo.status === 'complete') {
    pollTick();
  }
});

startPolling();
