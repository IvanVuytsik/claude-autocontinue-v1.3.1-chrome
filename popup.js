(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const statusPill     = document.getElementById('status-pill');
  const statusText     = document.getElementById('status-text');
  const countEl        = document.getElementById('count');
  const remainingEl    = document.getElementById('remaining');
  const pctEl          = document.getElementById('pct');
  const progressFill   = document.getElementById('progress-fill');
  const maxInput       = document.getElementById('max-input');
  const toggleEnabled  = document.getElementById('toggle-enabled');
  const noLimitChk     = document.getElementById('no-limit-chk');
  const btnToggle      = document.getElementById('btn-toggle');
  const btnReset       = document.getElementById('btn-reset');

  let state = {
    paused: false,
    maxContinues: 20,
    continueCount: 0,
  };

  function applyState(s) {
    state = { ...state, ...s };
    const { paused, maxContinues, continueCount } = state;

    const unlimited = maxContinues === 0;
    const pct       = unlimited ? 0 : Math.min((continueCount / maxContinues) * 100, 100);
    const remaining = unlimited ? '\u221e' : Math.max(maxContinues - continueCount, 0);
    const atMax     = !unlimited && continueCount >= maxContinues;

    statusPill.className   = 'status-pill ' + (atMax ? 'max' : paused ? 'off' : 'on');
    statusText.textContent = atMax ? 'MAX' : paused ? 'OFF' : 'ON';

    countEl.textContent     = continueCount;
    remainingEl.textContent = remaining;
    pctEl.textContent       = unlimited
      ? `${continueCount} / \u221e`
      : `${continueCount} / ${maxContinues}`;

    progressFill.style.width = pct + '%';
    progressFill.className   = 'progress-fill' +
      (pct >= 90 ? ' danger' : pct >= 60 ? ' warn' : '');

    maxInput.value         = unlimited ? '' : maxContinues;
    maxInput.disabled      = unlimited;
    maxInput.style.opacity = unlimited ? '0.35' : '1';

    if (noLimitChk) noLimitChk.checked   = unlimited;
    toggleEnabled.checked                = !paused;
    btnToggle.textContent                = paused ? 'Resume' : 'Pause';
  }

  function sendToTab(msg) {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }

  chrome.storage.local.get(
    ['paused', 'maxContinues', 'continueCount'],
    (data) => applyState({
      paused:         data.paused         ?? false,
      maxContinues:   data.maxContinues   ?? 20,
      continueCount:  data.continueCount  ?? 0,
    })
  );

  toggleEnabled.addEventListener('change', () => {
    const newPaused = !toggleEnabled.checked;
    chrome.storage.local.set({ paused: newPaused });
    sendToTab({ type: 'setPaused', value: newPaused });
    applyState({ paused: newPaused });
  });

  noLimitChk.addEventListener('change', () => {
    const unlimited = noLimitChk.checked;
    const val = unlimited ? 0 : (parseInt(maxInput.value, 10) || 20);
    chrome.storage.local.set({ maxContinues: val });
    sendToTab({ type: 'setMax', value: val });
    applyState({ maxContinues: val });
  });

  btnToggle.addEventListener('click', () => {
    const newPaused = !state.paused;
    chrome.storage.local.set({ paused: newPaused });
    sendToTab({ type: 'setPaused', value: newPaused });
    applyState({ paused: newPaused });
  });

  btnReset.addEventListener('click', () => {
    chrome.storage.local.set({ continueCount: 0, paused: false });
    sendToTab({ type: 'reset' });
    applyState({ continueCount: 0, paused: false });
    btnReset.textContent   = 'Done \u2713';
    btnReset.style.color   = '#22c55e';
    setTimeout(() => {
      btnReset.textContent = 'Reset counter';
      btnReset.style.color = '';
    }, 1200);
  });

  maxInput.addEventListener('change', () => {
    const val = Math.max(1, Math.min(999, parseInt(maxInput.value, 10) || 20));
    maxInput.value = val;
    chrome.storage.local.set({ maxContinues: val });
    sendToTab({ type: 'setMax', value: val });
    applyState({ maxContinues: val });
  });

  chrome.storage.onChanged.addListener((changes) => {
    const next = {};
    if (changes.continueCount) next.continueCount = changes.continueCount.newValue;
    if (changes.paused)        next.paused        = changes.paused.newValue;
    if (Object.keys(next).length) applyState(next);
  });

})();
