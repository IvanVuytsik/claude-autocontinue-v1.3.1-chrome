(function () {
  'use strict';

  const POLL_MS             = 4000;
  const CLICK_DELAY         = 1200;
  const TOAST_MS            = 3500;
  const BG_TAKEOVER_TIMEOUT = 60000;

  let continueCount  = 0;
  let maxContinues   = 20;
  let paused         = false;
  let intervalId     = null;
  let pendingAction  = false;
  let extensionContextUnavailable = false;

  let bgWorkerActive    = false;
  let bgTakeoverTimer   = null;

  requestBackground({ type: 'getSettings' }).then((data) => {
    paused        = data.paused ?? false;
    maxContinues  = data.maxContinues ?? 20;
    continueCount = data.continueCount ?? 0;
    if (!paused) startPolling();
  }).catch((error) => {
    if (!handleBackgroundRequestError('load settings', error)) {
      startPolling();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'setPaused') {
      paused = msg.value;
      paused ? stopPolling() : startPolling();
    }

    if (msg.type === 'setMax') {
      maxContinues = msg.value;
    }

    if (msg.type === 'reset') {
      continueCount  = 0;
      paused         = false;
      pendingAction  = false;
      bgWorkerActive = false;
      clearTimeout(bgTakeoverTimer);
      startPolling();
    }

    if (msg.type === 'bgTakeover') {
      bgWorkerActive = true;
      pendingAction  = true;

      clearTimeout(bgTakeoverTimer);
      bgTakeoverTimer = setTimeout(() => {
        bgWorkerActive = false;
        pendingAction  = false;
      }, BG_TAKEOVER_TIMEOUT);
    }

    if (msg.type === 'backgroundContinued') {
      clearTimeout(bgTakeoverTimer);
      continueCount  = msg.count;
      maxContinues   = msg.max;
      pendingAction  = false;
      bgWorkerActive = false;
      showToast(msg.count, msg.max);
      if (msg.max > 0 && msg.count >= msg.max) stopPolling();
    }
  });

  function isElementVisible(el) {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function getActionType(el) {
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.innerText ||
      el.textContent ||
      ''
    ).trim();
    const match = label.match(/^(retry|continue)[.!…]?$/i);
    return match ? match[1].toLowerCase() : null;
  }

  function dismissBlockingDialogs() {
    const dialogs = [...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]'
    )].filter(isElementVisible);

    if (!dialogs.length) return false;

    for (const dialog of dialogs) {
      const closeButton = [...dialog.querySelectorAll(
        'button, [role="button"], [aria-label], [title]'
      )].find((el) => {
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
          isElementVisible(el);
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

    return true;
  }

  function findActionButton() {
    if (dismissBlockingDialogs()) return null;

    const candidates = [...document.querySelectorAll(
      'button, [role="button"], a[href], [role="link"], [tabindex], [onclick]'
    )].filter(el =>
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true' &&
      isElementVisible(el) &&
      getActionType(el)
    );
    if (!candidates.length) return null;

    const retry = candidates.filter(el => getActionType(el) === 'retry');
    const pool = retry.length ? retry : candidates;
    return pool[pool.length - 1];
  }

  function sendContinueMessage() {
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

  function performContinuation() {
    if (dismissBlockingDialogs()) {
      pendingAction = false;
      return;
    }

    const action = findActionButton();
    if (!action) {
      if (sendContinueMessage()) {
        onContinued();
        return;
      }
      pendingAction = false;
      return;
    }

    action.click();
    onContinued();
  }

  function onContinued() {
    continueCount++;
    showToast(continueCount, maxContinues);
    if (maxContinues > 0 && continueCount >= maxContinues) stopPolling();
    pendingAction = false;
    requestBackground({ type: 'incrementContinueCount' }).then((data) => {
      if (extensionContextUnavailable) return;
      continueCount = data.continueCount;
      maxContinues = data.maxContinues;
      if (maxContinues > 0 && continueCount >= maxContinues) stopPolling();
    }).catch((error) => {
      handleBackgroundRequestError('save continuation count', error);
    });
  }

  function handleBackgroundRequestError(action, error) {
    const message = [
      error?.message,
      error?.stack,
      String(error),
    ].filter(Boolean).join(' ');
    if (/extension context invalidated|receiving end does not exist|message port closed|could not establish connection/i.test(message)) {
      extensionContextUnavailable = true;
      paused = true;
      pendingAction = false;
      stopPolling();
      clearTimeout(bgTakeoverTimer);
      return true;
    }

    console.error(`[AutoContinue] Could not ${action}:`, error);
    return false;
  }

  function requestBackground(message) {
    return new Promise((resolve, reject) => {
      if (!globalThis.chrome?.runtime?.sendMessage) {
        reject(new Error('Chrome extension messaging is unavailable'));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        try {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
          } else if (!response || response.error) {
            reject(new Error(response?.error || 'The background worker returned no response'));
          } else {
            resolve(response);
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function poll() {
    if (extensionContextUnavailable || paused || pendingAction || bgWorkerActive) return;
    if (maxContinues > 0 && continueCount >= maxContinues) return;
    if (!findActionButton()) return;

    pendingAction = true;

    setTimeout(() => {
      if (extensionContextUnavailable || paused || bgWorkerActive) {
        pendingAction = false;
        return;
      }
      performContinuation();
    }, CLICK_DELAY);
  }

  function startPolling() {
    if (!intervalId) intervalId = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    clearInterval(intervalId);
    intervalId = null;
  }

  function injectToastStyles() {
    if (document.getElementById('cac-styles')) return;
    const s = document.createElement('style');
    s.id = 'cac-styles';
    s.textContent = `
      #cac-toast {
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        display: flex; align-items: center; gap: 10px;
        background: #16181c; color: #f0f2f5;
        font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
        font-size: 12px; font-weight: 500;
        padding: 10px 14px; border-radius: 8px;
        border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 4px 24px rgba(0,0,0,.4);
        pointer-events: none; opacity: 0; transform: translateY(6px);
        transition: opacity .2s, transform .2s;
        max-width: 280px; line-height: 1.4;
      }
      #cac-toast.show { opacity: 1; transform: translateY(0); }
      #cac-toast.hide { opacity: 0; transform: translateY(4px); }
      .cac-icon {
        width: 18px; height: 18px; border-radius: 5px; background: #4f8ef7;
        flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      }
      .cac-icon.warn   { background: #f59e0b; }
      .cac-icon svg { width: 10px; height: 10px; fill: white; }
      .cac-title { color: #f0f2f5; }
      .cac-sub   { color: #555c6a; font-size: 11px; margin-top: 1px; }
      .cac-badge {
        margin-left: auto; font-size: 10px; font-weight: 600;
        padding: 2px 6px; border-radius: 4px; letter-spacing: .02em; flex-shrink: 0;
        background: rgba(79,142,247,.15); color: #4f8ef7;
      }
      .cac-badge.warn   { background: rgba(245,158,11,.15); color: #f59e0b; }
    `;
    document.head.appendChild(s);
  }

  let toastTimer = null;

  function showToast(count, max, isMax = false, mode) {
    injectToastStyles();

    let toast = document.getElementById('cac-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'cac-toast';
      document.body.appendChild(toast);
    }

    clearTimeout(toastTimer);

    const isWarn = !isMax && count / max >= 0.75;
    const iconClass  = isMax || isWarn ? 'warn' : '';
    const badgeClass = isMax || isWarn ? 'warn' : '';

    const title = isMax   ? 'Limit reached'
                :            'Continued automatically';

    const sub = isMax ? 'Increase max in the popup' : 'Claude hit the tool-use cap';

    const badge = `${count}/${max === 0 ? 'inf' : max}`;

    toast.innerHTML = `
      <div class="cac-icon ${iconClass}">
        <svg viewBox="0 0 24 24"><path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z"/></svg>
      </div>
      <div class="cac-body">
        <div class="cac-title"></div>
        <div class="cac-sub"></div>
      </div>
      <div class="cac-badge ${badgeClass}"></div>`;

    toast.querySelector('.cac-title').textContent = title;
    toast.querySelector('.cac-sub').textContent   = sub;
    toast.querySelector('.cac-badge').textContent = badge;

    toast.classList.remove('show', 'hide');
    void toast.offsetWidth;
    toast.classList.add('show');

    toastTimer = setTimeout(() => {
      toast.classList.replace('show', 'hide');
    }, TOAST_MS);
  }

})();
