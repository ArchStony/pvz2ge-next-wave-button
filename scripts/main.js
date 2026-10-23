const MOD_ID = 'next-wave-button';
const MOD_VERSION = '1.2.0';
const COCOS_MODULE = 'cc';
const LEVEL_CONTROLLER_MODULE = 'chunks:///_virtual/levelController.ts';
const UI_MODULE = 'chunks:///_virtual/UI.ts';
const KEY_LISTENER_MODULE = 'chunks:///_virtual/KeyListener.ts';
const ZOMBIES_MODULE = 'chunks:///_virtual/Zombies.ts';
const SQUARE_MODULE = 'chunks:///_virtual/Square.ts';
const HUD_ID = 'gp-next-wave-button';
const STYLE_ID = 'gp-next-wave-button-style';
const SVG_NS = 'http://www.w3.org/2000/svg';
const TRANSACTION_COOLDOWN_MS = 650;
const RAID_DRAIN_TIMEOUT_MS = 30000;
const HOLD_DELAY_MS = 150;
const HOLD_REPEAT_MS = 150;
const STANDARD_QUIET_MS = 300;
const ZOMBIE_QUEUE_SPACING_MIN = 0;
const ZOMBIE_QUEUE_SPACING_MAX = 2;
const RAID_GROUP_MODES = new Set(['off', 'sweep', 'global']);
const HUD_IMAGE_WIDTH = 139;
const HUD_IMAGE_HEIGHT = 140;
const DEFAULT_SETTINGS = {
  nextWaveKey: 'TAB',
  raidGroupMode: 'sweep',
  advanceMode: 'standard',
  zombieQueueSpacing: 0.5,
  keepButtonVisible: false,
};
const SPECIAL_MODE_RE = /MiniGame|Minigame|Bowling|Beghouled|Vasebreak|Rhythm|LastStand|Cannon|Camel|Zomboss|Boss/i;
const SPECIAL_OBJECT_RE = /MiniGame|Minigame|BowlingMinigame|Beghouled|Vasebreak|RhythmGame|LastStandMinigame|CannonMinigame|CamelMinigame|ZombossBattle|BossBattle/i;

let ctx = null;
let cc = null;
let modules = null;
let hudButton = null;
let hudStyle = null;
let hudLabel = null;
let hudQueueBadge = null;
let updateTimerCancel = null;
let sessionWatchCancel = null;
let retryTimerCancel = null;
let bindingPanelRefreshTimer = null;
let raidHookLastLevelName = '';
let raidHookErrorLogged = false;
let busy = false;
let stopped = false;
let captureMode = false;
let keydownHandler = null;
let keyupHandler = null;
let storageHandle = null;
let cooldownUntil = 0;
let lastResult = { ok: false, reason: 'not-started' };
let settings = { ...DEFAULT_SETTINGS };
const pendingRaids = new Set();
const pendingWaveActions = new Set();
const raidHookWrappedInstances = new WeakSet();
const waveActionHookWrappedInstances = new WeakSet();
const sweepSleepPatches = new Map();
let interactionHold = null;
let sweepQueue = 0;
let sweepInputAccepted = 0;
let sweepSleepBypassedCalls = 0;
let sweepWorkerRunning = false;
let raidPartyActiveCount = 0;
let raidGroupCompressedCalls = 0;
let zombieQueueHookInstalled = false;
let zombieQueueAdjustments = 0;
let zombieQueueModeLevel = null;
let zombieQueueModeAllowed = false;
let pointerReleaseInstalled = false;
let pointerUpHandler = null;
let pointerCancelHandler = null;
let windowBlurHandler = null;
let visibilityChangeHandler = null;
let interactionTakeovers = 0;
let observedWave = -1;
let observedZombieCount = -1;
let lastWaveActivityAt = 0;
let hudAssetUrls = null;
let hudFontFace = null;
let hudRemainingCount = null;

function log(level, message) {
  const line = `[下一波] ${message}`;
  try {
    const target = ctx && ctx.log && ctx.log[level];
    if (typeof target === 'function') {
      target.call(ctx.log, line);
      return;
    }
  } catch (_) {
    // Fall through to the game console for diagnostics.
  }
  const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  try {
    console[consoleMethod](line);
  } catch (_) {
    // Logging must never break the transaction.
  }
}

function toast(message, type) {
  try {
    if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') {
      ctx.ui.toast(message, type || 'info');
    }
  } catch (error) {
    log('warn', `toast failed: ${String(error)}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForRenderedFrames(count = 2) {
  const frames = Math.max(1, Number(count) || 1);
  return new Promise((resolve) => {
    let remaining = frames;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(finish, frames * 60 + 40);
    const step = () => {
      remaining--;
      if (remaining <= 0) {
        finish();
        return;
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
      else setTimeout(step, 16);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
    else setTimeout(step, 16);
  });
}

function normalizeZombieQueueSpacing(value) {
  if (value === null || value === undefined || value === '') return null;
  const spacing = Number(value);
  if (!Number.isFinite(spacing)
    || spacing < ZOMBIE_QUEUE_SPACING_MIN
    || spacing > ZOMBIE_QUEUE_SPACING_MAX) {
    return null;
  }
  return spacing;
}

function normalizeRaidGroupMode(value) {
  return RAID_GROUP_MODES.has(value) ? value : null;
}

function shouldCompressRaidGroups(level = null) {
  if (level && !getModeInfo(level).modeAllowed) return false;
  return settings.raidGroupMode === 'global'
    || (settings.raidGroupMode === 'sweep' && settings.advanceMode === 'sweep');
}

async function loadSettings() {
  try {
    if (!ctx.storage || typeof ctx.storage.open !== 'function') return;
    storageHandle = await ctx.storage.open({
      scope: 'global',
      version: 7,
      defaults: { ...DEFAULT_SETTINGS },
      validate(value) {
        return !!value
          && typeof value === 'object'
          && typeof value.nextWaveKey === 'string'
          && RAID_GROUP_MODES.has(value.raidGroupMode)
          && (value.advanceMode === 'standard' || value.advanceMode === 'sweep')
          && typeof value.keepButtonVisible === 'boolean'
          && typeof value.zombieQueueSpacing === 'number'
          && Number.isFinite(value.zombieQueueSpacing)
          && value.zombieQueueSpacing >= ZOMBIE_QUEUE_SPACING_MIN
          && value.zombieQueueSpacing <= ZOMBIE_QUEUE_SPACING_MAX;
      },
      migrate(value, fromVersion) {
        if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
        const migrated = {
          ...DEFAULT_SETTINGS,
          ...value,
        };
        if (fromVersion < 3) {
          migrated.advanceMode = DEFAULT_SETTINGS.advanceMode;
        }
        if (fromVersion < 5
          && (value.zombieQueueSpacing === undefined || value.zombieQueueSpacing === 0.2)) {
          migrated.zombieQueueSpacing = DEFAULT_SETTINGS.zombieQueueSpacing;
        }
        if (fromVersion < 7 || value.raidGroupMode === undefined) {
          migrated.raidGroupMode = value.instantFinalWave === false
            ? 'off'
            : DEFAULT_SETTINGS.raidGroupMode;
        }
        delete migrated.instantFinalWave;
        return migrated;
      },
    });
    const stored = await storageHandle.read();
    settings = {
      ...DEFAULT_SETTINGS,
      ...(stored && typeof stored === 'object' ? stored : {}),
    };
    settings.nextWaveKey = normalizeBinding(settings.nextWaveKey) || DEFAULT_SETTINGS.nextWaveKey;
    if (settings.advanceMode !== 'standard' && settings.advanceMode !== 'sweep') {
      settings.advanceMode = DEFAULT_SETTINGS.advanceMode;
    }
    settings.keepButtonVisible = !!settings.keepButtonVisible;
    settings.zombieQueueSpacing = normalizeZombieQueueSpacing(settings.zombieQueueSpacing)
      ?? DEFAULT_SETTINGS.zombieQueueSpacing;
    settings.raidGroupMode = normalizeRaidGroupMode(settings.raidGroupMode)
      ?? DEFAULT_SETTINGS.raidGroupMode;
    delete settings.instantFinalWave;
    log(
      'info',
      `settings loaded: key=${settings.nextWaveKey}, raidGroupMode=${settings.raidGroupMode}, advanceMode=${settings.advanceMode}, keepButtonVisible=${settings.keepButtonVisible}, zombieQueueSpacing=${settings.zombieQueueSpacing}`,
    );
  } catch (error) {
    log('warn', `settings load failed: ${String(error)}`);
  }
}

async function persistSettings() {
  if (!storageHandle) return;
  try {
    await storageHandle.update(() => ({ ...settings }));
  } catch (error) {
    log('warn', `settings save failed: ${String(error)}`);
  }
}

function getKeyCodeTable() {
  if (modules && modules.cocos && modules.cocos.KeyCode) return modules.cocos.KeyCode;
  return cc && cc.KeyCode ? cc.KeyCode : null;
}

function normalizeBinding(value) {
  if (typeof value !== 'string') return null;
  const table = getKeyCodeTable();
  if (!table) return value.trim().toUpperCase();
  let candidate = value.trim();
  if (candidate.startsWith('KeyCode.')) candidate = candidate.slice('KeyCode.'.length);
  const aliases = {
    Tab: 'TAB',
    Escape: 'ESCAPE',
    Esc: 'ESCAPE',
    Enter: 'ENTER',
    Space: 'SPACE',
    Backspace: 'BACKSPACE',
    Delete: 'DELETE',
    Home: 'HOME',
    End: 'END',
    PageUp: 'PAGE_UP',
    PageDown: 'PAGE_DOWN',
    ArrowLeft: 'ARROW_LEFT',
    ArrowRight: 'ARROW_RIGHT',
    ArrowUp: 'ARROW_UP',
    ArrowDown: 'ARROW_DOWN',
    ShiftLeft: 'SHIFT_LEFT',
    ShiftRight: 'SHIFT_RIGHT',
    ControlLeft: 'CTRL_LEFT',
    ControlRight: 'CTRL_RIGHT',
    AltLeft: 'ALT_LEFT',
    AltRight: 'ALT_RIGHT',
  };
  if (aliases[candidate]) candidate = aliases[candidate];
  candidate = candidate.toUpperCase();
  return Number.isFinite(table[candidate]) ? candidate : null;
}

function keyNameFromEvent(event) {
  const table = getKeyCodeTable();
  if (!table || !Number.isFinite(event.keyCode)) return null;
  for (const [name, code] of Object.entries(table)) {
    if (code === event.keyCode) return name;
  }
  return null;
}

function bindingDisplay(binding) {
  const keyListener = modules && modules.keyListener && modules.keyListener.KeyListener;
  const table = getKeyCodeTable();
  const code = table && table[binding];
  if (keyListener && typeof keyListener.KeyCodeToString === 'function' && Number.isFinite(code)) {
    try {
      return keyListener.KeyCodeToString(code);
    } catch (_) {
      // Fall back to the stored name.
    }
  }
  return binding;
}

function bindingConflict(binding) {
  const keyListener = modules && modules.keyListener && modules.keyListener.KeyListener;
  const binds = keyListener && keyListener.KeyBinds;
  if (!binds || typeof binds !== 'object') return null;
  for (const [action, value] of Object.entries(binds)) {
    if (value !== binding) continue;
    if (action.startsWith('Game_') || action.startsWith('AirRaid_')) return action;
  }
  return null;
}

export async function setNextWaveKey(binding) {
  const normalized = normalizeBinding(binding);
  if (!normalized) throw new Error(`unsupported key binding: ${String(binding)}`);
  const conflict = bindingConflict(normalized);
  if (conflict) throw new Error(`key conflict: ${conflict}`);
  settings.nextWaveKey = normalized;
  await persistSettings();
  log('info', `next-wave key set to ${normalized}`);
  updateHud();
  return normalized;
}

export async function setRaidGroupMode(mode) {
  const normalized = normalizeRaidGroupMode(mode);
  if (!normalized) throw new Error(`unsupported raid group mode: ${String(mode)}`);
  settings.raidGroupMode = normalized;
  await persistSettings();
  log('info', `raid group compression set to ${settings.raidGroupMode}`);
  updateHud();
  return settings.raidGroupMode;
}

export async function setFinalWaveInstantSpawn(enabled) {
  return setRaidGroupMode(enabled ? 'global' : 'off');
}

export async function setAdvanceMode(mode) {
  if (mode !== 'standard' && mode !== 'sweep') {
    throw new Error(`unsupported advance mode: ${String(mode)}`);
  }
  settings.advanceMode = mode;
  sweepQueue = 0;
  sweepInputAccepted = 0;
  sweepSleepBypassedCalls = 0;
  cancelInteractionHold();
  await persistSettings();
  log('info', `advance mode set to ${mode}`);
  updateHud();
  return mode;
}

export async function setKeepButtonVisible(enabled) {
  settings.keepButtonVisible = !!enabled;
  await persistSettings();
  log('info', `keep button visible ${settings.keepButtonVisible ? 'enabled' : 'disabled'}`);
  updateHud();
  return settings.keepButtonVisible;
}

export async function setZombieQueueSpacing(value) {
  const spacing = normalizeZombieQueueSpacing(value);
  if (spacing === null) {
    throw new Error(
      `queue spacing must be between ${ZOMBIE_QUEUE_SPACING_MIN} and ${ZOMBIE_QUEUE_SPACING_MAX}`,
    );
  }
  settings.zombieQueueSpacing = spacing;
  await persistSettings();
  log('info', `zombie queue spacing set to ${spacing}`);
  updateHud();
  return spacing;
}

function refreshBindingPanelDom() {
  try {
    const sections = Array.from(document.querySelectorAll('.gp-section'));
    const section = sections.find((candidate) => {
      return Array.from(candidate.querySelectorAll('h4')).some((heading) => (
        heading.textContent.trim() === '快捷键'
      ));
    });
    if (!section) return;

    const shortcutHeading = Array.from(section.querySelectorAll('h4')).find((heading) => (
      heading.textContent.trim() === '快捷键'
    ));
    const shortcutGroup = shortcutHeading && shortcutHeading.nextElementSibling;
    if (!shortcutGroup) return;

    const valueNode = shortcutGroup.querySelector('p');
    if (valueNode) {
      valueNode.textContent = `当前快捷键: ${bindingDisplay(settings.nextWaveKey)}`;
    }

    const buttons = Array.from(shortcutGroup.querySelectorAll('button[aria-label]'));
    const currentButton = buttons.find((button) => {
      const label = button.getAttribute('aria-label') || '';
      return label === '设置下一波快捷键' || label === '请按下新快捷键…';
    });
    if (!currentButton) return;

    let button = currentButton;
    if (button.dataset.bindingRefreshBound !== 'true') {
      const replacement = button.cloneNode(true);
      replacement.dataset.bindingRefreshBound = 'true';
      replacement.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        requestKeyCapture();
      });
      button.replaceWith(replacement);
      button = replacement;
    }

    const label = captureMode ? '请按下新快捷键…' : '设置下一波快捷键';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.disabled = captureMode;
  } catch (_) {
    // The F9 panel may be closed or be replaced between capture steps.
  }
}

function scheduleBindingPanelRefresh() {
  if (bindingPanelRefreshTimer) clearTimeout(bindingPanelRefreshTimer);
  bindingPanelRefreshTimer = setTimeout(() => {
    bindingPanelRefreshTimer = null;
    refreshBindingPanelDom();
  }, 0);
}

function requestKeyCapture() {
  captureMode = true;
  toast('请按下“下一波”的新快捷键，Esc 取消', 'info');
  updateHud();
  scheduleBindingPanelRefresh();
}

function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toLowerCase();
  return tag === 'input'
    || tag === 'textarea'
    || tag === 'select'
    || !!target.isContentEditable;
}

function isGpPanelOpen() {
  try {
    const overlay = document.getElementById('gp-overlay');
    if (overlay) {
      const rect = overlay.getBoundingClientRect();
      const style = getComputedStyle(overlay);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.right > 1
        && rect.left < window.innerWidth;
    }
    return document.querySelectorAll('.gp-tab').length > 0;
  } catch (_) {
    return false;
  }
}

function restoreGameFocus() {
  try {
    if (hudButton) hudButton.blur();
  } catch (_) {
    // Ignore focus races.
  }
  try {
    const canvas = cc && cc.game && cc.game.canvas;
    if (canvas) {
      canvas.tabIndex = -1;
      canvas.focus({ preventScroll: true });
    }
  } catch (_) {
    // Some WebView versions do not accept focus options.
    try {
      if (cc && cc.game && cc.game.canvas) cc.game.canvas.focus();
    } catch (_) {
      // Focus restoration is best-effort.
    }
  }
}

function setHudPressed(pressed) {
  if (!hudButton) return;
  hudButton.setAttribute('data-pressed', pressed ? 'true' : 'false');
}

function cancelInteractionHold() {
  setHudPressed(false);
  if (!interactionHold) return;
  if (interactionHold.timer) clearTimeout(interactionHold.timer);
  if (interactionHold.interval) clearInterval(interactionHold.interval);
  interactionHold = null;
}

function startInteractionHold(source) {
  if (stopped) return false;
  if (interactionHold) {
    const previousSource = interactionHold.source;
    cancelInteractionHold();
    if (previousSource !== source) {
      interactionTakeovers++;
      log('info', `input source switched: ${previousSource} -> ${source}`);
    }
  }
  const state = getState();
  if (!state.active || !state.modeAllowed || state.terminal || state.paused) return false;
  if (settings.advanceMode === 'sweep' && !state.canSweep) return false;
  if (settings.advanceMode === 'standard' && !state.canAdvance) return false;

  interactionHold = {
    source,
    fired: false,
    startedAt: performance.now(),
    timer: null,
    interval: null,
  };
  setHudPressed(true);
  if (settings.advanceMode === 'sweep') {
    interactionHold.timer = setTimeout(() => {
      if (!interactionHold || interactionHold.source !== source) return;
      interactionHold.fired = true;
      recordSweepInput(1);
      interactionHold.interval = setInterval(() => {
        if (!interactionHold || interactionHold.source !== source) return;
        recordSweepInput(1);
      }, HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
  }
  return true;
}

function finishInteractionHold(source, cancelled) {
  if (!interactionHold || interactionHold.source !== source) return;
  const hold = interactionHold;
  cancelInteractionHold();
  if (cancelled || hold.fired) return;

  if (settings.advanceMode === 'standard') {
    triggerNextWave(source);
  } else {
    recordSweepInput(1);
  }
}

function installPointerReleaseListeners() {
  if (pointerReleaseInstalled) return;
  pointerReleaseInstalled = true;
  pointerUpHandler = (event) => {
    if (!interactionHold) {
      setHudPressed(false);
      return;
    }
    if (interactionHold.source !== 'hud') return;
    if (Number.isFinite(event.button) && event.button !== 0) return;
    setHudPressed(false);
    finishInteractionHold('hud', false);
    restoreGameFocus();
  };
  pointerCancelHandler = () => {
    if (!interactionHold || interactionHold.source !== 'hud') return;
    setHudPressed(false);
    finishInteractionHold('hud', true);
  };
  windowBlurHandler = () => {
    cancelInteractionHold();
  };
  visibilityChangeHandler = () => {
    if (document.hidden) cancelInteractionHold();
  };
  window.addEventListener('pointerup', pointerUpHandler, true);
  window.addEventListener('pointercancel', pointerCancelHandler, true);
  window.addEventListener('blur', windowBlurHandler, true);
  document.addEventListener('visibilitychange', visibilityChangeHandler, true);
}

function removePointerReleaseListeners() {
  if (!pointerReleaseInstalled) return;
  try {
    if (pointerUpHandler) window.removeEventListener('pointerup', pointerUpHandler, true);
    if (pointerCancelHandler) window.removeEventListener('pointercancel', pointerCancelHandler, true);
    if (windowBlurHandler) window.removeEventListener('blur', windowBlurHandler, true);
    if (visibilityChangeHandler) document.removeEventListener('visibilitychange', visibilityChangeHandler, true);
  } catch (_) {
    // Ignore cleanup races.
  }
  pointerReleaseInstalled = false;
  pointerUpHandler = null;
  pointerCancelHandler = null;
  windowBlurHandler = null;
  visibilityChangeHandler = null;
}

function recordSweepInput(count) {
  if (settings.advanceMode !== 'sweep' || stopped) return false;
  const state = getState();
  if (!state.active || !state.modeAllowed || state.terminal || state.paused) return false;
  if (state.finalWaveActive) {
    sweepQueue = 0;
    updateHud();
    return false;
  }

  const remainingTransitions = Math.max(0, state.waveCount - state.currentWave);
  const cap = Math.max(0, Math.min(state.waveCount, remainingTransitions));
  const amount = Math.max(1, Number(count) || 1);
  const room = Math.max(0, cap - sweepQueue);
  if (room <= 0) return false;
  const accepted = Math.min(amount, room);
  sweepQueue += accepted;
  sweepInputAccepted += accepted;
  updateHud();
  processSweepQueue();
  return accepted > 0;
}

function shouldAccelerateSweepSleep(level) {
  if (stopped || settings.advanceMode !== 'sweep') return false;
  if (!getModeInfo(level).modeAllowed) return false;
  if (raidPartyActiveCount > 0 && !shouldCompressRaidGroups()) return false;
  if (sweepWorkerRunning
    || sweepQueue > 0
    || busy
    || pendingRaids.size > 0
    || pendingWaveActions.size > 0) {
    return true;
  }
  const waveCount = Number(level && level.waveManagerProps && level.waveManagerProps.Waves
    ? level.waveManagerProps.Waves.length
    : 0);
  const currentWave = Number(level && Number.isFinite(level.currentWave) ? level.currentWave : -1);
  return waveCount > 0 && currentWave >= waveCount - 1;
}

function installSweepSleepHook(level) {
  if (!level || typeof level.sleep !== 'function' || sweepSleepPatches.has(level)) return false;
  if (!getModeInfo(level).modeAllowed) return false;
  const originalSleep = level.sleep;
  const sweepSleep = function acceleratedSweepSleep(...args) {
    if (shouldAccelerateSweepSleep(level)) {
      sweepSleepBypassedCalls++;
      return waitForRenderedFrames(1);
    }
    return originalSleep.apply(this, args);
  };
  sweepSleep.__nextWaveSweepSleep = true;
  level.sleep = sweepSleep;
  sweepSleepPatches.set(level, { originalSleep, sweepSleep });
  log('info', `sweep sleep hook installed: ${raidHookLastLevelName}`);
  return true;
}

function restoreSweepSleepHooks() {
  for (const [level, patch] of sweepSleepPatches) {
    try {
      if (level && level.sleep === patch.sweepSleep) level.sleep = patch.originalSleep;
    } catch (_) {
      // Best-effort cleanup for a scene that may already be destroyed.
    }
  }
  sweepSleepPatches.clear();
}

async function processSweepQueue() {
  if (sweepWorkerRunning || stopped) return;
  sweepWorkerRunning = true;
  try {
    while (sweepQueue > 0 && !stopped) {
      const state = getState();
      if (!state.active || !state.modeAllowed || state.terminal) {
        sweepQueue = 0;
        break;
      }
      if (state.paused) {
        await delay(150);
        continue;
      }
      if (state.finalWaveActive) {
        sweepQueue = 0;
        break;
      }
      if (state.pending > 0 || state.busy || Date.now() < cooldownUntil) {
        await delay(100);
        continue;
      }

      const result = await triggerNextWave('sweep-queue');
      if (result && result.ok) {
        sweepQueue = Math.max(0, sweepQueue - 1);
      } else if (result && result.reason === 'cooldown') {
        await delay(100);
      } else if (result && (
        result.reason === 'busy'
        || result.reason === 'wave-actions-pending'
        || result.reason === 'waiting-wave-entry'
      )) {
        await delay(100);
      } else {
        sweepQueue = 0;
      }
      updateHud();
      await waitForRenderedFrames(1);
    }
  } finally {
    sweepWorkerRunning = false;
    updateHud();
  }
}

function handleGlobalKeyDown(event) {
  if (stopped) return;
  if (event.repeat) {
    if (interactionHold && interactionHold.source === 'keyboard') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;

  if (captureMode) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = keyNameFromEvent(event);
    if (!name) {
      toast('这个按键不能在游戏中使用', 'warning');
      return;
    }
    if (name === 'ESCAPE') {
      captureMode = false;
      toast('已取消快捷键绑定', 'info');
      scheduleBindingPanelRefresh();
      restoreGameFocus();
      return;
    }
    if (name === 'DELETE' || name === 'BACKSPACE') {
      setNextWaveKey(DEFAULT_SETTINGS.nextWaveKey).then(() => {
        captureMode = false;
        scheduleBindingPanelRefresh();
        toast('已恢复默认快捷键 Tab', 'success');
        restoreGameFocus();
      }).catch((error) => {
        toast(String(error), 'error');
      });
      return;
    }
    setNextWaveKey(name).then(() => {
      captureMode = false;
      scheduleBindingPanelRefresh();
      toast(`下一波快捷键：${bindingDisplay(name)}`, 'success');
      restoreGameFocus();
    }).catch((error) => {
      toast(`按键冲突：${String(error)}`, 'warning');
    });
    return;
  }

  if (event.shiftKey || isEditableTarget(event.target) || isGpPanelOpen()) return;
  const table = getKeyCodeTable();
  if (!table || event.keyCode !== table[settings.nextWaveKey]) return;
  const state = getState();
  if (!state.active || !state.modeAllowed) return;

  if (startInteractionHold('keyboard')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    restoreGameFocus();
  }
}

function handleGlobalKeyUp(event) {
  if (stopped || event.ctrlKey || event.altKey || event.metaKey) return;
  const table = getKeyCodeTable();
  if (!table || event.keyCode !== table[settings.nextWaveKey]) return;
  if (!interactionHold || interactionHold.source !== 'keyboard') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishInteractionHold('keyboard', false);
}

function installKeyboardListener() {
  if (keydownHandler) return;
  keydownHandler = (event) => handleGlobalKeyDown(event);
  keyupHandler = (event) => handleGlobalKeyUp(event);
  window.addEventListener('keydown', keydownHandler, true);
  window.addEventListener('keyup', keyupHandler, true);
}

function removeKeyboardListener() {
  if (!keydownHandler && !keyupHandler) return;
  try {
    if (keydownHandler) window.removeEventListener('keydown', keydownHandler, true);
    if (keyupHandler) window.removeEventListener('keyup', keyupHandler, true);
  } catch (_) {
    // Ignore cleanup races.
  }
  keydownHandler = null;
  keyupHandler = null;
  captureMode = false;
}

async function loadSystemModule(path) {
  const engine = ctx && ctx.unsafe && ctx.unsafe.engine;
  let result = null;
  if (engine && typeof engine.getSystemModule === 'function') {
    result = engine.getSystemModule(path);
    if (result && typeof result.then === 'function') {
      result = await result;
    }
  }
  if (result) return result;

  const system = globalThis.System;
  if (system && typeof system.import === 'function') {
    return system.import(path);
  }
  throw new Error(`System module unavailable: ${path}`);
}

function getLevelController() {
  const levelPlay = modules && modules.levelController && modules.levelController.LevelPlay;
  if (levelPlay && levelPlay.component) return levelPlay.component;

  try {
    const scene = cc && cc.director && cc.director.getScene();
    const node = scene && scene.getChildByName('LevelController');
    if (!node) return null;
    const components = node.components || [];
    return components.find((item) => item && item.__classname__ === 'levelController') || null;
  } catch (_) {
    return null;
  }
}

function getUiInGame() {
  const uiModule = modules && modules.ui;
  const uiClass = uiModule && uiModule.UIInGame;
  if (uiClass && uiClass.component) return uiClass.component;

  try {
    const scene = cc && cc.director && cc.director.getScene();
    const node = scene && scene.getChildByName('Canvas') && scene.getChildByName('Canvas').getChildByName('UIInGame');
    if (!node) return null;
    const components = node.components || [];
    return components.find((item) => item && item.__classname__ === 'UIInGame') || null;
  } catch (_) {
    return null;
  }
}

function getComponentByClass(node, className) {
  return (node && node.components || []).find((component) => {
    return component && component.__classname__ === className;
  }) || null;
}

function getPauseButtonScreenRect() {
  try {
    const ui = getUiInGame();
    const pauseNode = ui && ui.pauseButton && ui.pauseButton.node;
    const canvas = cc && cc.game && cc.game.canvas;
    const view = cc && cc.view;
    if (!pauseNode || !pauseNode.activeInHierarchy || !canvas || !view) return null;

    const transform = getComponentByClass(pauseNode, 'cc.UITransform');
    if (!transform || typeof transform.getBoundingBoxToWorld !== 'function') return null;

    const box = transform.getBoundingBoxToWorld();
    const viewport = view.getViewportRect();
    const scaleX = view.getScaleX();
    const scaleY = view.getScaleY();
    const canvasRect = canvas.getBoundingClientRect();
    const pixelRatioX = canvas.width / canvasRect.width;
    const pixelRatioY = canvas.height / canvasRect.height;
    if (!box || box.width <= 0 || box.height <= 0 || !viewport
      || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)
      || !Number.isFinite(pixelRatioX) || !Number.isFinite(pixelRatioY)
      || pixelRatioX <= 0 || pixelRatioY <= 0) {
      return null;
    }

    const width = box.width * scaleX / pixelRatioX;
    const height = box.height * scaleY / pixelRatioY;
    const left = canvasRect.left + (viewport.x + box.x * scaleX) / pixelRatioX;
    const top = canvasRect.top + canvasRect.height
      - (viewport.y + (box.y + box.height) * scaleY) / pixelRatioY;
    if (![width, height, left, top].every(Number.isFinite)) return null;

    return {
      left,
      top,
      width,
      height,
      centerX: left + width / 2,
      bottom: top + height,
    };
  } catch (_) {
    return null;
  }
}

function getHudPlacement() {
  const pause = getPauseButtonScreenRect();
  if (!pause) return null;
  const width = Math.min(pause.width, pause.height);
  const height = width * (HUD_IMAGE_HEIGHT / HUD_IMAGE_WIDTH);
  const gap = Math.max(3, width * 0.075);
  return {
    pause,
    button: {
      left: pause.centerX - width / 2,
      top: pause.bottom + gap,
      width,
      height,
    },
    gap,
  };
}

function applyHudPlacement(button, placement) {
  if (!button || !placement) return;
  const target = placement.button;
  button.style.left = `${target.left.toFixed(2)}px`;
  button.style.top = `${target.top.toFixed(2)}px`;
  button.style.width = `${target.width.toFixed(2)}px`;
  button.style.height = `${target.height.toFixed(2)}px`;
  button.style.setProperty('--gp-next-wave-side', `${target.width.toFixed(2)}px`);
}

async function loadHudAssets() {
  if (hudAssetUrls) return hudAssetUrls;
  if (!ctx || !ctx.files || typeof ctx.files.own !== 'function') {
    throw new Error('pack file reader unavailable');
  }

  const reader = ctx.files.own();
  const [normalBytes, sweepNormalBytes, fontBytes] = await Promise.all([
    reader.readBytes('assets/next-wave-button.png'),
    reader.readBytes('assets/sweep-next-wave-button.png'),
    reader.readBytes('assets/GPNextWaveCount.otf'),
  ]);
  if (!normalBytes || !sweepNormalBytes || !fontBytes) {
    throw new Error('button assets missing');
  }
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Blob URL unavailable');
  }

  const fontUrl = URL.createObjectURL(new Blob([fontBytes], { type: 'font/otf' }));
  try {
    if (typeof FontFace === 'function' && document && document.fonts) {
      hudFontFace = new FontFace('GPNextWaveFont', `url("${fontUrl}")`, {
        style: 'normal',
        weight: 'normal',
      });
      await hudFontFace.load();
      document.fonts.add(hudFontFace);
    }
  } catch (error) {
    hudFontFace = null;
    log('warn', `HUD font load failed: ${String(error)}`);
  }

  hudAssetUrls = {
    normal: URL.createObjectURL(new Blob([normalBytes], { type: 'image/png' })),
    sweepNormal: URL.createObjectURL(new Blob([sweepNormalBytes], { type: 'image/png' })),
    font: fontUrl,
  };
  applyHudAssets();
  return hudAssetUrls;
}

function applyHudAssets() {
  if (!hudButton || !hudAssetUrls) return;
  const sweep = settings.advanceMode === 'sweep';
  const normal = sweep ? hudAssetUrls.sweepNormal : hudAssetUrls.normal;
  hudButton.style.setProperty('--gp-next-wave-normal', `url("${normal}")`);
  hudButton.setAttribute('data-asset-variant', sweep ? 'sweep' : 'standard');
  hudButton.setAttribute('data-assets', 'ready');
}

function releaseHudAssets() {
  if (!hudAssetUrls) return;
  try {
    URL.revokeObjectURL(hudAssetUrls.normal);
    URL.revokeObjectURL(hudAssetUrls.sweepNormal);
    URL.revokeObjectURL(hudAssetUrls.font);
  } catch (_) {
    // Object URLs are best-effort cleanup.
  }
  try {
    if (hudFontFace && document && document.fonts) document.fonts.delete(hudFontFace);
  } catch (_) {
    // Font face cleanup is best-effort.
  }
  hudFontFace = null;
  hudAssetUrls = null;
}

function getHudLayout() {
  const placement = getHudPlacement();
  const rect = hudButton && hudButton.getBoundingClientRect();
  return {
    pause: placement && placement.pause,
    button: placement && placement.button,
    rendered: rect && {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    gap: placement && placement.gap,
    assetsReady: !!hudAssetUrls,
  };
}

function getModeInfo(level) {
  if (!level) {
    return {
      modeAllowed: false,
      modeLabel: 'unknown',
      modeReason: 'not-running',
      hasWaves: false,
      hasWaveManager: false,
      specialMode: false,
    };
  }

  const definition = level.levelDefinition || {};
  const modules = Array.isArray(definition.Modules) ? definition.Modules : [];
  const objects = Array.isArray(level.currentLevelObjects) ? level.currentLevelObjects : [];
  const objectSignatures = objects.flatMap((object) => {
    if (!object) return [];
    return [object.objclass || '', ...(Array.isArray(object.aliases) ? object.aliases : [])];
  });
  const hasWaves = !!(level.waveManagerProps
    && Array.isArray(level.waveManagerProps.Waves)
    && level.waveManagerProps.Waves.length > 0);
  const hasWaveManager = modules.some((value) => /NewWaves/i.test(value))
    || objectSignatures.includes('WaveManagerModuleProperties');
  const explicitMiniGame = definition.IsDangerRoomMiniGame === true
    || level.isDangerroomMiniGame === true
    || definition.IsVasebreaker === true
    || level.isVasebreaker === true
    || level.lastStand === true
    || !!level.rhythmGameProps
    || level.camelComboOn === true;
  const specialMode = explicitMiniGame
    || !!level.bossZombie
    || modules.some((value) => SPECIAL_MODE_RE.test(value))
    || objectSignatures.some((value) => SPECIAL_OBJECT_RE.test(value));
  const isLevelOfTheDay = definition.IsLevelOfTheDay === true;
  const isDangerRoom = definition.IsDangerRoom === true
    || level.isDangerroom === true;
  const isNormalDangerRoom = isDangerRoom && !explicitMiniGame;
  const isStandardWave = !isLevelOfTheDay && !isNormalDangerRoom && !specialMode;
  const allowedShape = isStandardWave || isLevelOfTheDay || isNormalDangerRoom;
  const modeAllowed = hasWaves && hasWaveManager && !specialMode && allowedShape;

  let modeReason = null;
  if (!hasWaves) modeReason = 'no-waves';
  else if (!hasWaveManager) modeReason = 'no-wave-manager';
  else if (specialMode) modeReason = 'special-mode';
  else if (!allowedShape) modeReason = 'unsupported-mode';

  let modeLabel = 'normal';
  if (isLevelOfTheDay) modeLabel = 'level-of-the-day';
  else if (isNormalDangerRoom) modeLabel = 'danger-room';
  else if (specialMode) modeLabel = 'special';

  return {
    modeAllowed,
    modeLabel,
    modeReason,
    hasWaves,
    hasWaveManager,
    specialMode,
  };
}

function inspectStandardReadiness(level, currentWave) {
  const zombies = level && Array.isArray(level._ZombiesInThisWave)
    ? level._ZombiesInThisWave
    : [];
  const count = zombies.length;
  const timestamp = performance.now();
  if (currentWave !== observedWave || count !== observedZombieCount) {
    observedWave = currentWave;
    observedZombieCount = count;
    lastWaveActivityAt = timestamp;
  }

  let blockers = 0;
  let considered = 0;
  for (const zombie of zombies) {
    if (!zombie) continue;
    let alive = true;
    try {
      if (typeof zombie.isAlive === 'function') alive = !!zombie.isAlive();
    } catch (_) {
      alive = true;
    }
    if (!alive) continue;
    if (zombie.objdataOwn && zombie.objdataOwn.IgnoredInWaves) continue;
    considered++;
    const active = !!(zombie.node && zombie.node.activeInHierarchy);
    const inLawn = !!zombie.inLnC;
    if (!active || !inLawn) blockers++;
  }

  const quietForMs = Math.max(0, timestamp - lastWaveActivityAt);
  const waveActionsPending = pendingWaveActions.size;
  const ready = pendingWaveActions.size === 0
    && blockers === 0
    && quietForMs >= STANDARD_QUIET_MS;
  return {
    ready,
    blockers,
    considered,
    registered: count,
    waveActionsPending,
    quietForMs,
  };
}

function getState() {
  const scene = cc && cc.director ? cc.director.getScene() : null;
  const level = getLevelController();
  const ui = getUiInGame();
  const waveCount = Number(level && level.waveManagerProps && level.waveManagerProps.Waves
    ? level.waveManagerProps.Waves.length
    : 0);
  const currentWave = Number(level && Number.isFinite(level.currentWave) ? level.currentWave : -1);
  const gameStarted = !!(level && level.gameStarted);
  const paused = !!(ui && ui.paused);
  const terminal = !!(level && (level.gameWon || level.gameLost || level.gameOver));
  const active = !!(scene && scene.name === 'inGameScene' && gameStarted && currentWave >= 0 && waveCount > 0);
  const mode = getModeInfo(level);
  const pending = pendingWaveActions.size;
  const pendingRaidCount = pendingRaids.size;
  const standard = inspectStandardReadiness(level, currentWave);
  const tutorialLocked = !!(level && level.Tutorial_Wave_Stuck);
  const mustKillAll = !!(level && level.MustKillAllThisWave);
  const finalWaveActive = active && currentWave >= waveCount;
  const nextWouldBeFinal = active && currentWave + 1 >= waveCount;

  let reason = null;
  if (!active) reason = 'not-running';
  else if (!mode.modeAllowed) reason = mode.modeReason || 'unsupported-mode';
  else if (terminal) reason = 'game-ended';
  else if (paused) reason = 'paused';
  else if (tutorialLocked) reason = 'tutorial-locked';
  else if (mustKillAll) reason = 'must-kill-all';
  else if (finalWaveActive) reason = 'final-wave-active';
  else if (busy) reason = 'busy';
  else if (pending > 0) reason = 'wave-actions-pending';
  else if (settings.advanceMode === 'standard' && !standard.ready) reason = 'waiting-wave-entry';
  else if (Date.now() < cooldownUntil) reason = 'cooldown';
  else if (!level || typeof level.nextWave !== 'function') reason = 'nextWave-unavailable';

  const canSweep = active
    && mode.modeAllowed
    && !terminal
    && !paused
    && !tutorialLocked
    && !finalWaveActive;

  return {
    active,
    currentWave,
    waveCount,
    pending,
    pendingRaids: pendingRaidCount,
    pendingWaveActions: pending,
    standard,
    advanceMode: settings.advanceMode,
    keepButtonVisible: settings.keepButtonVisible,
    sweepQueue,
    sweepInputAccepted,
    sweepSleepBypassedCalls,
    zombieQueueSpacing: settings.zombieQueueSpacing,
    zombieQueueAdjustments,
    canSweep,
    terminal,
    paused,
    tutorialLocked,
    mustKillAll,
    finalWaveActive,
    nextWouldBeFinal,
    modeAllowed: mode.modeAllowed,
    modeLabel: mode.modeLabel,
    modeReason: mode.modeReason,
    hasWaves: mode.hasWaves,
    hasWaveManager: mode.hasWaveManager,
    canAdvance: reason === null,
    reason,
  };
}

function installRaidHook(targetLevel) {
  const level = targetLevel || getLevelController();
  if (!level) return false;
  if (!getModeInfo(level).modeAllowed) return false;
  if (raidHookWrappedInstances.has(level)) {
    raidHookLastLevelName = String(level.levelNameString || (level.levelNameLabel && level.levelNameLabel.string) || '');
    return true;
  }
  const hooks = ctx && ctx.unsafe && ctx.unsafe.hooks;
  const methodName = 'readWave_RaidingPartyZombieSpawnerProps';

  if (typeof level[methodName] !== 'function') {
    if (!raidHookErrorLogged) {
      log('warn', 'RaidingParty method unavailable on current level instance');
      raidHookErrorLogged = true;
    }
    return false;
  }
  if (!hooks || typeof hooks.wrapMethod !== 'function') {
    if (!raidHookErrorLogged) {
      log('warn', 'unsafe hook API unavailable; delayed-group tracking disabled');
      raidHookErrorLogged = true;
    }
    return false;
  }

  hooks.wrapMethod({
    target: level,
    methodName,
    handler({ args, thisArg, callNext }) {
      const activeLevel = thisArg || level;
      const waveCount = Number(activeLevel && activeLevel.waveManagerProps && activeLevel.waveManagerProps.Waves
        ? activeLevel.waveManagerProps.Waves.length
        : 0);
      const currentWave = Number(activeLevel && Number.isFinite(activeLevel.currentWave) ? activeLevel.currentWave : -1);
      const compressRaidGroups = shouldCompressRaidGroups(activeLevel);
      let originalSleep = null;
      let fastSleep = null;
      let fast = false;
      let raidScopeActive = true;
      raidPartyActiveCount++;

      if (compressRaidGroups && activeLevel && typeof activeLevel.sleep === 'function') {
        originalSleep = activeLevel.sleep;
        fast = true;
        fastSleep = function compressedRaidGroupSleep(...sleepArgs) {
          if (fast) {
            raidGroupCompressedCalls++;
            return waitForRenderedFrames(1);
          }
          return originalSleep.apply(this, sleepArgs);
        };
        activeLevel.sleep = fastSleep;
        log(
          'info',
          `raid group compression enabled: mode=${settings.raidGroupMode}, wave=${currentWave}/${waveCount}`,
        );
      }

      const releaseRaidScope = () => {
        if (!raidScopeActive) return;
        raidScopeActive = false;
        raidPartyActiveCount = Math.max(0, raidPartyActiveCount - 1);
        fast = false;
        if (activeLevel && fastSleep && activeLevel.sleep === fastSleep) {
          activeLevel.sleep = originalSleep;
        }
      };

      let result;
      try {
        result = callNext(...args);
      } catch (error) {
        releaseRaidScope();
        throw error;
      }

      if (!result || typeof result.then !== 'function') {
        releaseRaidScope();
        return result;
      }

      let tracked = null;
      tracked = Promise.resolve(result)
        .catch((error) => {
          log('error', `raiding-party drain failed: ${String(error)}`);
          throw error;
        })
        .finally(() => {
          if (tracked) pendingRaids.delete(tracked);
          releaseRaidScope();
          updateHud();
        });
      pendingRaids.add(tracked);
      updateHud();
      return tracked;
    },
  });

  raidHookWrappedInstances.add(level);
  raidHookLastLevelName = String(level.levelNameString || (level.levelNameLabel && level.levelNameLabel.string) || '');
  raidHookErrorLogged = false;
  log('info', `RaidingParty delayed-group hook installed on instance: ${raidHookLastLevelName}`);
  return true;
}

function installWaveActionHook(targetLevel) {
  const level = targetLevel || getLevelController();
  if (!level) return false;
  if (!getModeInfo(level).modeAllowed) return false;
  if (waveActionHookWrappedInstances.has(level)) return true;
  const hooks = ctx && ctx.unsafe && ctx.unsafe.hooks;
  if (typeof level.readWave !== 'function') {
    if (!raidHookErrorLogged) {
      log('warn', 'readWave unavailable on current level instance');
      raidHookErrorLogged = true;
    }
    return false;
  }
  if (!hooks || typeof hooks.wrapMethod !== 'function') {
    if (!raidHookErrorLogged) {
      log('warn', 'unsafe hook API unavailable for WaveAction tracking');
      raidHookErrorLogged = true;
    }
    return false;
  }

  hooks.wrapMethod({
    target: level,
    methodName: 'readWave',
    handler({ args, callNext }) {
      lastWaveActivityAt = performance.now();
      const result = callNext(...args);
      if (!result || typeof result.then !== 'function') return result;

      let tracked = null;
      tracked = Promise.resolve(result)
        .catch((error) => {
          log('error', `WaveAction failed: ${String(error)}`);
          throw error;
        })
        .finally(() => {
          if (tracked) pendingWaveActions.delete(tracked);
          lastWaveActivityAt = performance.now();
          updateHud();
        });
      pendingWaveActions.add(tracked);
      updateHud();
      return tracked;
    },
  });

  waveActionHookWrappedInstances.add(level);
  log('info', 'readWave WaveAction tracking installed on instance');
  return true;
}

function applyZombieQueueSpacing(zombie) {
  const square = modules && modules.square && modules.square.Square;
  const squareWidth = Number(square && square.SquareWidth);
  const lane = zombie && zombie.spawnLane;
  const currentOffset = Number(lane && lane.zombieSpawnOffset);
  const spacing = normalizeZombieQueueSpacing(settings.zombieQueueSpacing);
  if (!Number.isFinite(squareWidth) || squareWidth <= 0
    || !Number.isFinite(currentOffset) || spacing === null) {
    return false;
  }

  lane.zombieSpawnOffset = currentOffset
    - (2 * squareWidth)
    + (spacing * squareWidth);
  zombieQueueAdjustments++;
  return true;
}

function shouldAdjustZombieQueue() {
  if (stopped || !modules) return false;
  const level = getLevelController();
  if (!level) return false;
  if (level !== zombieQueueModeLevel || !zombieQueueModeAllowed) {
    zombieQueueModeLevel = level;
    zombieQueueModeAllowed = getModeInfo(level).modeAllowed;
  }
  return zombieQueueModeAllowed;
}

function installZombieQueueSpacingHook() {
  if (zombieQueueHookInstalled) return true;
  const zombiesTarget = modules && modules.zombies && modules.zombies.zombies;
  const hooks = ctx && ctx.unsafe && ctx.unsafe.hooks;
  if (!zombiesTarget || typeof zombiesTarget.spawnZombieFromLaneByID !== 'function') {
    log('warn', 'Zombies.spawnZombieFromLaneByID unavailable; queue spacing disabled');
    return false;
  }
  if (!hooks || typeof hooks.wrapMethod !== 'function') {
    log('warn', 'unsafe hook API unavailable; queue spacing disabled');
    return false;
  }

  hooks.wrapMethod({
    target: zombiesTarget,
    methodName: 'spawnZombieFromLaneByID',
    handler({ args, callNext }) {
      const adjustQueue = shouldAdjustZombieQueue();
      const result = callNext(...args);
      if (!adjustQueue || !result || typeof result.then !== 'function') return result;
      return Promise.resolve(result).then((zombie) => {
        if (!stopped) applyZombieQueueSpacing(zombie);
        return zombie;
      });
    },
  });

  zombieQueueHookInstalled = true;
  log('info', 'zombie queue spacing hook installed');
  return true;
}

function installLevelHooks(targetLevel) {
  const level = targetLevel || getLevelController();
  if (!level) return false;
  if (!getModeInfo(level).modeAllowed) return false;
  installSweepSleepHook(level);
  const raidOk = installRaidHook(level);
  const waveOk = installWaveActionHook(level);
  return raidOk && waveOk;
}

async function ensureModules() {
  if (!ctx || !ctx.unsafe || !ctx.unsafe.engine) {
    throw new Error('ctx.unsafe.engine unavailable');
  }
  cc = ctx.unsafe.engine.getCc
    ? ctx.unsafe.engine.getCc()
    : globalThis.cc;
  if (!cc) throw new Error('Cocos runtime unavailable');

  const [cocos, levelController, ui, keyListener, zombies, square] = await Promise.all([
    loadSystemModule(COCOS_MODULE),
    loadSystemModule(LEVEL_CONTROLLER_MODULE),
    loadSystemModule(UI_MODULE),
    loadSystemModule(KEY_LISTENER_MODULE),
    loadSystemModule(ZOMBIES_MODULE),
    loadSystemModule(SQUARE_MODULE),
  ]);
  if (!levelController || !levelController.LevelPlay || !levelController.levelController) {
    throw new Error('levelController exports missing');
  }
  if (!ui || !ui.UIInGame) throw new Error('UIInGame export missing');
  if (!keyListener || !keyListener.KeyListener) throw new Error('KeyListener export missing');
  if (!cocos || !cocos.KeyCode) throw new Error('Cocos KeyCode export missing');
  if (!zombies || !zombies.zombies) throw new Error('Zombies export missing');
  if (!square || !square.Square || !Number.isFinite(Number(square.Square.SquareWidth))) {
    throw new Error('SquareWidth export missing');
  }

  modules = { cocos, levelController, ui, keyListener, zombies, square };
  installZombieQueueSpacingHook();
  installLevelHooks();
  log('info', `modules ready: waveCount=${getState().waveCount}`);
  updateHud();
  return true;
}

function scheduleModuleRetry() {
  if (stopped || retryTimerCancel) return;
  if (!ctx || !ctx.runtime || typeof ctx.runtime.setInterval !== 'function') return;
  retryTimerCancel = ctx.runtime.setInterval(async () => {
    if (stopped || modules) {
      if (retryTimerCancel) retryTimerCancel();
      retryTimerCancel = null;
      return;
    }
    try {
      await ensureModules();
      if (retryTimerCancel) retryTimerCancel();
      retryTimerCancel = null;
    } catch (_) {
      // The next attempt will inspect the same modules again.
    }
  }, 1000, { label: 'next-wave-module-retry' });
}

function ensureHud() {
  if (!document || !document.body) return null;
  if (hudButton && hudButton.isConnected) return hudButton;

  hudStyle = document.getElementById(STYLE_ID);
  if (!hudStyle) {
    hudStyle = document.createElement('style');
    hudStyle.id = STYLE_ID;
    hudStyle.textContent = `
      #${HUD_ID} {
        position: fixed;
        left: -10000px;
        top: 0;
        width: 0;
        height: 0;
        z-index: 99990;
        display: none;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: #000;
        background-image: var(--gp-next-wave-normal, none);
        background-position: top center;
        background-repeat: no-repeat;
        background-size: 100% auto;
        color: #fff;
        font: 600 12px/1.15 "Microsoft YaHei", system-ui, sans-serif;
        text-align: center;
        cursor: pointer;
        user-select: none;
        touch-action: manipulation;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
        outline: none;
      }
      #${HUD_ID}:hover:not(:disabled) { filter: brightness(1.06); }
      #${HUD_ID}:disabled { cursor: default; filter: grayscale(0.65) brightness(0.65); }
      #${HUD_ID}[data-assets="ready"] {
        background-color: transparent;
        color: transparent;
        font-size: 0;
        box-shadow: none;
      }
      #${HUD_ID}[data-assets="ready"][data-pressed="true"]:not(:disabled) {
        filter: brightness(0.6056) saturate(0.7412);
      }
      #${HUD_ID} .gp-next-wave-overlay {
        position: absolute;
        inset: 0;
        display: none;
        width: 100%;
        height: 100%;
        overflow: visible;
        pointer-events: none;
        z-index: 2;
      }
      #${HUD_ID}[data-assets="ready"] .gp-next-wave-overlay {
        display: block;
      }
      #${HUD_ID} .gp-next-wave-plaque {
        fill: #bee5ef;
        stroke: #16374d;
        stroke-width: 2;
        filter: drop-shadow(0 2px 2px rgba(4, 16, 24, 0.52));
      }
      #${HUD_ID} .gp-next-wave-main-label,
      #${HUD_ID} .gp-next-wave-bottom-label {
        font-family: "FBUSV8C5EI_LABEL", "GPNextWaveFont", "Microsoft YaHei", sans-serif;
        font-weight: normal;
        font-synthesis: none;
        text-anchor: middle;
        dominant-baseline: middle;
        fill: #fafdff;
        stroke: #222528;
        stroke-linejoin: round;
        paint-order: stroke fill;
      }
      #${HUD_ID} .gp-next-wave-main-label {
        font-size: 20.9px;
        stroke-width: 3.5px;
      }
      #${HUD_ID} .gp-next-wave-bottom-label {
        font-size: 24px;
        font-variant-numeric: tabular-nums;
        letter-spacing: 3.5px;
        stroke-width: 4px;
      }
      #${HUD_ID} .gp-next-wave-queue {
        position: absolute;
        left: -7%;
        top: 38%;
        min-width: 26%;
        height: 21%;
        padding: 0 6%;
        display: none;
        align-items: center;
        justify-content: center;
        border: 1px solid #9ff4ff;
        border-radius: 999px;
        background: rgba(12, 31, 42, 0.94);
        color: #ffe45f;
        font-family: "GPNextWaveFont", "Microsoft YaHei", sans-serif;
        font-size: calc(var(--gp-next-wave-side, 56px) * 0.18);
        font-weight: normal;
        font-synthesis: none;
        line-height: 1;
        text-shadow: 0 1px 1px #000;
        pointer-events: none;
        z-index: 3;
      }
      #${HUD_ID}[data-show-queue="true"] .gp-next-wave-queue {
        display: flex;
      }
    `;
    document.head.appendChild(hudStyle);
  }

  hudButton = document.createElement('button');
  hudButton.id = HUD_ID;
  hudButton.type = 'button';
  hudButton.tabIndex = -1;
  hudButton.setAttribute('data-pressed', 'false');
  hudButton.setAttribute('aria-label', '下一波');
  hudButton.textContent = '';
  const hudOverlay = document.createElementNS(SVG_NS, 'svg');
  hudOverlay.classList.add('gp-next-wave-overlay');
  hudOverlay.setAttribute('viewBox', '0 0 139 140');
  hudOverlay.setAttribute('preserveAspectRatio', 'none');
  hudOverlay.setAttribute('aria-hidden', 'true');
  hudOverlay.setAttribute('focusable', 'false');
  const plaque = document.createElementNS(SVG_NS, 'rect');
  plaque.classList.add('gp-next-wave-plaque');
  plaque.setAttribute('x', '8');
  plaque.setAttribute('y', '102');
  plaque.setAttribute('width', '123');
  plaque.setAttribute('height', '35');
  plaque.setAttribute('rx', '10');
  hudLabel = document.createElementNS(SVG_NS, 'text');
  hudLabel.classList.add('gp-next-wave-main-label');
  hudLabel.setAttribute('x', '71');
  hudLabel.setAttribute('y', '58.5');
  hudLabel.setAttribute('transform', 'rotate(5 71 58.5)');
  hudLabel.textContent = '下一波';
  hudRemainingCount = document.createElementNS(SVG_NS, 'text');
  hudRemainingCount.classList.add('gp-next-wave-bottom-label');
  hudRemainingCount.setAttribute('x', '69.5');
  hudRemainingCount.setAttribute('y', '121.8');
  hudRemainingCount.textContent = '余0波';
  hudOverlay.appendChild(plaque);
  hudOverlay.appendChild(hudLabel);
  hudOverlay.appendChild(hudRemainingCount);
  hudQueueBadge = document.createElement('span');
  hudQueueBadge.className = 'gp-next-wave-queue';
  hudButton.appendChild(hudOverlay);
  hudButton.appendChild(hudQueueBadge);
  const stopPointer = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  hudButton.addEventListener('pointerdown', (event) => {
    stopPointer(event);
    if (Number.isFinite(event.button) && event.button !== 0) return;
    if (startInteractionHold('hud')) {
      try {
        hudButton.setPointerCapture(event.pointerId);
      } catch (_) {
        // Pointer capture is optional.
      }
    }
  }, true);
  hudButton.addEventListener('mousedown', stopPointer, true);
  hudButton.addEventListener('touchstart', (event) => event.stopPropagation(), {
    capture: true,
    passive: true,
  });
  hudButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.body.appendChild(hudButton);
  applyHudAssets();
  installPointerReleaseListeners();
  return hudButton;
}

function removeHud() {
  try {
    if (hudButton) hudButton.remove();
  } catch (_) {
    // Ignore teardown races.
  }
  try {
    if (hudStyle) hudStyle.remove();
  } catch (_) {
    // Ignore teardown races.
  }
  hudButton = null;
  hudStyle = null;
  hudLabel = null;
  hudQueueBadge = null;
  hudRemainingCount = null;
}

function reasonText(state) {
  switch (state.reason) {
    case 'paused': return '游戏已暂停';
    case 'wave-actions-pending': return '等待当前波出怪动作完成';
    case 'waiting-wave-entry': return '等待当前波僵尸进入地图';
    case 'busy': return '正在提交下一波';
    case 'must-kill-all': return '必须先清空当前波';
    case 'tutorial-locked': return '教程锁定中';
    case 'final-wave-active': return '当前已是最终波';
    case 'game-ended': return '关卡已结束';
    case 'nextWave-unavailable': return '目标方法不可用';
    case 'not-running': return '不在运行中的关卡';
    case 'no-waves': return '当前模式没有波次';
    case 'no-wave-manager': return '未找到正常波次管理器';
    case 'special-mode': return '小游戏、僵王或特殊模式不启用';
    case 'unsupported-mode': return '当前关卡类型不在白名单';
    case 'cooldown': return '短暂冷却中';
    default: return '立即推进下一波';
  }
}

function setCenteredSvgText(node, text, centerX) {
  if (!node) return;
  node.textContent = text;
  node.setAttribute('x', String(centerX));
  if (!hudButton || hudButton.style.display === 'none') return;
  try {
    const box = node.getBBox();
    const inkCenter = box.x + box.width / 2;
    if (box.width > 0 && Number.isFinite(inkCenter)) {
      node.setAttribute('x', String(centerX + (centerX - inkCenter)));
    }
  } catch (_) {
    // The next HUD refresh will retry once the SVG has been rendered.
  }
}

function updateHud() {
  if (stopped) return;
  try {
    const currentLevel = getLevelController();
    if (currentLevel) installLevelHooks(currentLevel);
  } catch (error) {
    if (!raidHookErrorLogged) {
      log('warn', `instance hook refresh failed: ${String(error)}`);
      raidHookErrorLogged = true;
    }
  }
  const button = ensureHud();
  if (!button) return;
  if (!interactionHold) setHudPressed(false);
  const state = getState();
  if (state.paused) cancelInteractionHold();
  button.setAttribute('data-advance-mode', state.advanceMode);
  applyHudAssets();
  const placement = getHudPlacement();
  if (!placement) {
    cancelInteractionHold();
    button.style.display = 'none';
    button.setAttribute('data-reason', 'pause-anchor-unavailable');
    return;
  }
  applyHudPlacement(button, placement);
  const standardVisible = state.advanceMode !== 'standard'
    || settings.keepButtonVisible
    || state.canAdvance;
  if (!state.active || state.terminal || !state.modeAllowed || !standardVisible) {
    cancelInteractionHold();
    button.style.display = 'none';
    button.setAttribute('data-reason', state.reason || 'hidden');
    return;
  }

  button.style.display = 'block';
  const enabled = state.advanceMode === 'sweep' ? state.canSweep : state.canAdvance;
  button.disabled = !enabled;
  button.setAttribute('aria-disabled', String(!enabled));
  button.setAttribute('data-wave', String(state.currentWave));
  button.setAttribute('data-wave-count', String(state.waveCount));
  button.setAttribute('data-pending', String(state.pending));
  button.setAttribute('data-queue', String(state.sweepQueue));
  button.setAttribute('data-show-queue', state.advanceMode === 'sweep' && state.sweepQueue > 0 ? 'true' : 'false');
  button.setAttribute('data-mode', state.modeLabel);
  button.setAttribute('data-reason', state.reason || 'ready');
  button.setAttribute('data-state', enabled ? 'ready' : 'busy');
  const remaining = Math.max(0, state.waveCount - state.currentWave);
  button.setAttribute('data-remaining', String(remaining));
  button.title = reasonText(state);
  const mainLabelText = state.advanceMode === 'sweep' ? '扫一波' : '下一波';
  const bottomLabelText = state.reason === 'final-wave-active' || state.nextWouldBeFinal
    ? '最终波'
    : `余${remaining}波`;
  setCenteredSvgText(hudLabel, mainLabelText, 71);
  setCenteredSvgText(hudRemainingCount, bottomLabelText, 69.5);
  if (hudQueueBadge) hudQueueBadge.textContent = `+${state.sweepQueue}`;
  button.setAttribute('aria-label', `${mainLabelText}，${bottomLabelText}`);
}

async function drainPendingWaveActions() {
  const deadline = Date.now() + RAID_DRAIN_TIMEOUT_MS;
  while (pendingWaveActions.size > 0) {
    if (Date.now() >= deadline) {
      throw new Error('timed out while draining wave actions');
    }
    await Promise.allSettled(Array.from(pendingWaveActions));
    if (pendingWaveActions.size > 0) await delay(120);
  }
}

async function triggerNextWave(source) {
  const initialState = getState();
  if (!initialState.canAdvance) {
    lastResult = { ok: false, reason: initialState.reason, source };
    return lastResult;
  }

  busy = true;
  setHudPressed(false);
  lastResult = { ok: false, reason: 'busy', source };
  updateHud();

  let level = null;
  let originalSleep = null;
  let patchedSleep = null;
  let originalGamingWarn = null;
  let patchedGamingWarn = null;
  let warningCount = 0;
  let beforeWave = null;
  let previousCountdown = null;
  let previousDamageCountdown = null;

  try {
    level = getLevelController();
    if (!level || typeof level.nextWave !== 'function') {
      throw new Error('levelController.nextWave unavailable');
    }

    beforeWave = Number(level.currentWave);
    previousCountdown = level.NextWaveCountdown;
    previousDamageCountdown = level.WaveZombieDamageCountdown;

    // Prevent the native update loop from loading the same wave while this
    // button transition is already being prepared.
    level.NextWaveCountdown = Number.POSITIVE_INFINITY;
    level.WaveZombieDamageCountdown = Number.POSITIVE_INFINITY;
    await drainPendingWaveActions();
    if (Number(level.currentWave) !== beforeWave) {
      throw new Error(`wave transition superseded: ${beforeWave} -> ${Number(level.currentWave)}`);
    }

    if (typeof level.gamingWarn === 'function') {
      originalGamingWarn = level.gamingWarn;
      patchedGamingWarn = function acceleratedGamingWarn(...warningArgs) {
        const result = originalGamingWarn.apply(this, warningArgs);
        warningCount++;
        try {
          if (this.inGameWarnLabel) {
            this.inGameWarnLabel.node.active = true;
            this.warnLabelA = 255;
          }
        } catch (_) {
          // The original warning still runs if a visual field is unavailable.
        }
        return result;
      };
      level.gamingWarn = patchedGamingWarn;
    }

    originalSleep = level.sleep;
    if (settings.advanceMode === 'standard' && typeof originalSleep === 'function') {
      let shortened = false;
      patchedSleep = function nextWaveSleep(...args) {
        if (!shortened) {
          shortened = true;
          return waitForRenderedFrames(2);
        }
        return originalSleep.apply(this, args);
      };
      level.sleep = patchedSleep;
    } else if (settings.advanceMode === 'sweep') {
      installSweepSleepHook(level);
    }

    const result = level.nextWave();
    if (result && typeof result.then === 'function') await result;
    if (warningCount > 0) await waitForRenderedFrames(1);

    const afterWave = Number(level.currentWave);
    if (!Number.isFinite(afterWave) || afterWave !== beforeWave + 1) {
      throw new Error(`wave delta invalid: ${beforeWave} -> ${afterWave}`);
    }

    cooldownUntil = Date.now() + TRANSACTION_COOLDOWN_MS;
    lastResult = {
      ok: true,
      source,
      beforeWave,
      afterWave,
      pendingRaids: pendingRaids.size,
      at: Date.now(),
    };
    log('info', `wave committed: ${beforeWave} -> ${afterWave} (${source})`);
    toast('下一波已提交', 'success');
    return lastResult;
  } catch (error) {
    lastResult = {
      ok: false,
      source,
      reason: 'transaction-failed',
      error: String(error),
      at: Date.now(),
    };
    log('error', `transaction failed: ${String(error)}`);
    toast('下一波提交失败，详见日志', 'error');
    if (level && previousCountdown !== null && beforeWave !== null && Number(level.currentWave) === beforeWave) {
      level.NextWaveCountdown = previousCountdown;
      level.WaveZombieDamageCountdown = previousDamageCountdown;
    }
    return lastResult;
  } finally {
    if (level && patchedSleep && level.sleep === patchedSleep) {
      level.sleep = originalSleep;
    }
    if (level && patchedGamingWarn && level.gamingWarn === patchedGamingWarn) {
      level.gamingWarn = originalGamingWarn;
    }
    busy = false;
    updateHud();
  }
}

function definePanel() {
  try {
    ctx.controls.definePanel({
      title: '下一波按钮',
      description: '该模组所有设置只会对“会出现下一波按钮的关卡”生效。',
      groups: [
        {
          title: '',
          items: [
            {
              type: 'action',
              key: 'next-wave',
              label: '立即推进下一波',
              disabled: () => !getState().canAdvance,
              onClick: () => triggerNextWave('panel'),
            },
          ],
        },
        {
          title: '快捷键',
          items: [
            {
              type: 'readonly',
              key: 'key-binding',
              label: '当前快捷键',
              getValue: () => captureMode
                ? '等待按键…'
                : bindingDisplay(settings.nextWaveKey),
            },
            {
              type: 'action',
              key: 'rebind-key',
              label: '设置下一波快捷键',
              visible: () => !captureMode,
              onClick: () => requestKeyCapture(),
            },
            {
              type: 'action',
              key: 'rebind-key-capture',
              label: '请按下新快捷键…',
              visible: () => captureMode,
              disabled: true,
              onClick: () => {},
            },
          ],
        },
        {
          title: '参数设置',
          items: [
            {
              type: 'select',
              key: 'advance-mode',
              label: '推进模式',
              options: [
                { value: 'standard', label: '标准：僵尸入场后显示按钮' },
                { value: 'sweep', label: '扫荡：可长按连续加波次' },
              ],
              getValue: () => settings.advanceMode,
              setValue: (value) => setAdvanceMode(value),
            },
            {
              type: 'number',
              key: 'zombie-queue-spacing',
              label: '同行排队间距（格）',
              min: ZOMBIE_QUEUE_SPACING_MIN,
              max: ZOMBIE_QUEUE_SPACING_MAX,
              step: 0.01,
              getValue: () => settings.zombieQueueSpacing,
              setValue: (value) => setZombieQueueSpacing(value),
            },
            {
              type: 'toggle',
              key: 'keep-button-visible',
              label: '保持按钮常态显示',
              getValue: () => settings.keepButtonVisible,
              setValue: (value) => setKeepButtonVisible(!!value),
            },
            {
              type: 'select',
              key: 'raid-group-compression',
              label: '压缩突袭小队的分组间隔',
              options: [
                { value: 'off', label: '关闭' },
                { value: 'sweep', label: '仅扫荡模式开启' },
                { value: 'global', label: '全局' },
              ],
              getValue: () => settings.raidGroupMode,
              setValue: (value) => setRaidGroupMode(value),
            },
          ],
        },
      ],
    });
    log('info', 'F9 panel registered');
  } catch (error) {
    log('warn', `F9 panel registration failed: ${String(error)}`);
  }
}

function watchSession() {
  try {
    sessionWatchCancel = ctx.game.sessions.watch((event) => {
      if (event.type === 'entered' || event.type === 'started') {
        restoreSweepSleepHooks();
        pendingRaids.clear();
        pendingWaveActions.clear();
        sweepQueue = 0;
        sweepInputAccepted = 0;
        sweepSleepBypassedCalls = 0;
        raidPartyActiveCount = 0;
        raidGroupCompressedCalls = 0;
        interactionTakeovers = 0;
        zombieQueueAdjustments = 0;
        zombieQueueModeLevel = null;
        zombieQueueModeAllowed = false;
        cancelInteractionHold();
        observedWave = -1;
        observedZombieCount = -1;
        lastWaveActivityAt = performance.now();
        busy = false;
        cooldownUntil = 0;
      } else if (event.type === 'ended') {
        restoreSweepSleepHooks();
        pendingRaids.clear();
        pendingWaveActions.clear();
        sweepQueue = 0;
        sweepInputAccepted = 0;
        sweepSleepBypassedCalls = 0;
        zombieQueueAdjustments = 0;
        zombieQueueModeLevel = null;
        zombieQueueModeAllowed = false;
        cancelInteractionHold();
        busy = false;
      }
      updateHud();
    }, { label: 'next-wave-session' });
  } catch (error) {
    log('warn', `session watch unavailable: ${String(error)}`);
  }
}

function exposeDebugApi() {
  try {
    globalThis.__nextWaveButtonDebug = {
      getState,
      getLastResult: () => lastResult,
      getPendingCount: () => pendingRaids.size,
      getSweepInputCount: () => sweepInputAccepted,
      getSweepSleepBypassedCount: () => sweepSleepBypassedCalls,
      getSettings: () => ({ ...settings }),
      setNextWaveKey: (binding) => setNextWaveKey(binding),
      setRaidGroupMode: (mode) => setRaidGroupMode(mode),
      setFinalWaveInstantSpawn: (enabled) => setFinalWaveInstantSpawn(enabled),
      setAdvanceMode: (mode) => setAdvanceMode(mode),
      setKeepButtonVisible: (enabled) => setKeepButtonVisible(enabled),
      setZombieQueueSpacing: (value) => setZombieQueueSpacing(value),
      getZombieQueueSpacingStats: () => ({
        spacing: settings.zombieQueueSpacing,
        adjustments: zombieQueueAdjustments,
        hookInstalled: zombieQueueHookInstalled,
      }),
      getHudLayout,
      getRaidHookStatus: () => {
        const currentLevel = getLevelController();
        return {
          wrapped: !!(currentLevel && raidHookWrappedInstances.has(currentLevel)),
          waveActionWrapped: !!(currentLevel && waveActionHookWrappedInstances.has(currentLevel)),
          levelName: raidHookLastLevelName,
          pending: pendingRaids.size,
          pendingWaveActions: pendingWaveActions.size,
          sweepQueue,
          sweepInputAccepted,
          sweepSleepBypassedCalls,
          raidGroupCompressedCalls,
          raidPartyActiveCount,
          interactionTakeovers,
          sweepSleepHookWrapped: !!(currentLevel && sweepSleepPatches.has(currentLevel)),
          raidGroupMode: settings.raidGroupMode,
          advanceMode: settings.advanceMode,
          keepButtonVisible: settings.keepButtonVisible,
          zombieQueueSpacing: settings.zombieQueueSpacing,
          zombieQueueHookInstalled,
          zombieQueueAdjustments,
        };
      },
      trigger: (source) => triggerNextWave(source || 'debug'),
      updateHud,
    };
    globalThis.__nextWaveButtonApi = globalThis.__nextWaveButtonDebug;
  } catch (_) {
    // Diagnostic API is optional.
  }
}

function cleanup() {
  if (stopped) return;
  stopped = true;
  try {
    if (updateTimerCancel) updateTimerCancel();
  } catch (_) {
    // Ignore cleanup races.
  }
  try {
    if (sessionWatchCancel) sessionWatchCancel();
  } catch (_) {
    // Ignore cleanup races.
  }
  try {
    if (retryTimerCancel) retryTimerCancel();
  } catch (_) {
    // Ignore cleanup races.
  }
  updateTimerCancel = null;
  sessionWatchCancel = null;
  retryTimerCancel = null;
  if (bindingPanelRefreshTimer) clearTimeout(bindingPanelRefreshTimer);
  bindingPanelRefreshTimer = null;
  removeKeyboardListener();
  removePointerReleaseListeners();
  cancelInteractionHold();
  restoreSweepSleepHooks();
  pendingRaids.clear();
  pendingWaveActions.clear();
  sweepQueue = 0;
  sweepInputAccepted = 0;
  sweepSleepBypassedCalls = 0;
  raidPartyActiveCount = 0;
  raidGroupCompressedCalls = 0;
  interactionTakeovers = 0;
  zombieQueueAdjustments = 0;
  zombieQueueModeLevel = null;
  zombieQueueModeAllowed = false;
  busy = false;
  removeHud();
  releaseHudAssets();
  try {
    if (globalThis.__nextWaveButtonDebug) delete globalThis.__nextWaveButtonDebug;
    if (globalThis.__nextWaveButtonApi) delete globalThis.__nextWaveButtonApi;
  } catch (_) {
    // Ignore cleanup races.
  }
  log('info', 'cleanup complete');
}

export async function setup(modContext) {
  ctx = modContext;
  stopped = false;
  log('info', `setup v${MOD_VERSION} api=${ctx.compat ? ctx.compat.getApiVersion() : 'unknown'}`);

  await loadSettings();
  definePanel();
  watchSession();
  try {
    await loadHudAssets();
  } catch (error) {
    log('warn', `HUD assets unavailable; using fallback: ${String(error)}`);
  }
  ensureHud();
  installKeyboardListener();
  exposeDebugApi();

  try {
    await ensureModules();
  } catch (error) {
    log('warn', `initial module load failed; retrying: ${String(error)}`);
    scheduleModuleRetry();
  }

  try {
    updateTimerCancel = ctx.runtime.setInterval(() => updateHud(), 250, {
      label: 'next-wave-hud',
    });
  } catch (error) {
    log('error', `runtime interval unavailable: ${String(error)}`);
  }

  updateHud();
  return cleanup;
}

export function teardown() {
  cleanup();
}

export default { setup, teardown };
