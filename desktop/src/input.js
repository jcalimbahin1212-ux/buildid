// Native input injection via @nut-tree-fork/nut-js (cross-platform).
// Receives the small JSON event format produced by the web client and
// translates it into mouse/keyboard actions on the local OS.

const { mouse, keyboard, Button, Point, Key, straightTo } = require('@nut-tree-fork/nut-js');

// nut-js defaults to a slow "human-like" speed; we want immediate dispatch.
mouse.config.mouseSpeed = 10000;
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

let baseDisplay = { x: 0, y: 0, width: 1920, height: 1080 };

function setBaseDisplay(bounds) {
  baseDisplay = bounds;
}

function toScreenPoint(nx, ny) {
  const x = Math.round(baseDisplay.x + nx * baseDisplay.width);
  const y = Math.round(baseDisplay.y + ny * baseDisplay.height);
  return new Point(x, y);
}

function buttonOf(name) {
  switch (name) {
    case 'right': return Button.RIGHT;
    case 'middle': return Button.MIDDLE;
    default: return Button.LEFT;
  }
}

// Throttle mouse moves to ~120 Hz to avoid overwhelming the input subsystem.
let lastMoveTs = 0;
let pendingMove = null;
let moveTimer = null;
const MOVE_INTERVAL_MS = 8;

async function flushMove() {
  moveTimer = null;
  if (!pendingMove) return;
  const pt = pendingMove;
  pendingMove = null;
  lastMoveTs = Date.now();
  try { await mouse.setPosition(pt); } catch (e) { console.warn('[input] move failed:', e.message); }
}

async function dispatchInput(ev) {
  switch (ev.t) {
    case 'mm': {
      pendingMove = toScreenPoint(ev.x, ev.y);
      const since = Date.now() - lastMoveTs;
      if (since >= MOVE_INTERVAL_MS) {
        if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
        await flushMove();
      } else if (!moveTimer) {
        moveTimer = setTimeout(flushMove, MOVE_INTERVAL_MS - since);
      }
      return;
    }
    case 'md': {
      await mouse.setPosition(toScreenPoint(ev.x, ev.y));
      await mouse.pressButton(buttonOf(ev.b));
      return;
    }
    case 'mu': {
      await mouse.setPosition(toScreenPoint(ev.x, ev.y));
      await mouse.releaseButton(buttonOf(ev.b));
      return;
    }
    case 'wh': {
      const dy = Math.round(ev.dy || 0);
      const dx = Math.round(ev.dx || 0);
      // nut-js scrollDown/scrollUp take steps; pixels/120 ≈ one notch.
      if (dy > 0) await mouse.scrollDown(Math.max(1, Math.round(dy / 40)));
      else if (dy < 0) await mouse.scrollUp(Math.max(1, Math.round(-dy / 40)));
      if (dx > 0) await mouse.scrollRight(Math.max(1, Math.round(dx / 40)));
      else if (dx < 0) await mouse.scrollLeft(Math.max(1, Math.round(-dx / 40)));
      return;
    }
    case 'kd': {
      const k = mapKey(ev.code, ev.key);
      if (k) try { await keyboard.pressKey(k); } catch (e) { console.warn('[input] keydown', e.message); }
      return;
    }
    case 'ku': {
      const k = mapKey(ev.code, ev.key);
      if (k) try { await keyboard.releaseKey(k); } catch (e) { console.warn('[input] keyup', e.message); }
      return;
    }
  }
}

// Map browser KeyboardEvent.code to nut-js Key enum.
const codeMap = {
  // Letters
  KeyA: Key.A, KeyB: Key.B, KeyC: Key.C, KeyD: Key.D, KeyE: Key.E, KeyF: Key.F, KeyG: Key.G,
  KeyH: Key.H, KeyI: Key.I, KeyJ: Key.J, KeyK: Key.K, KeyL: Key.L, KeyM: Key.M, KeyN: Key.N,
  KeyO: Key.O, KeyP: Key.P, KeyQ: Key.Q, KeyR: Key.R, KeyS: Key.S, KeyT: Key.T, KeyU: Key.U,
  KeyV: Key.V, KeyW: Key.W, KeyX: Key.X, KeyY: Key.Y, KeyZ: Key.Z,
  // Digits
  Digit0: Key.Num0, Digit1: Key.Num1, Digit2: Key.Num2, Digit3: Key.Num3, Digit4: Key.Num4,
  Digit5: Key.Num5, Digit6: Key.Num6, Digit7: Key.Num7, Digit8: Key.Num8, Digit9: Key.Num9,
  // Function keys
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  // Control keys
  Enter: Key.Enter, Escape: Key.Escape, Tab: Key.Tab, Space: Key.Space,
  Backspace: Key.Backspace, Delete: Key.Delete, Insert: Key.Insert, Home: Key.Home,
  End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
  ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right,
  CapsLock: Key.CapsLock, NumLock: Key.NumLock, ScrollLock: Key.ScrollLock,
  PrintScreen: Key.Print, Pause: Key.Pause,
  // Modifiers
  ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
  ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
  MetaLeft: Key.LeftSuper, MetaRight: Key.RightSuper,
  ContextMenu: Key.Menu,
  // Punctuation
  Minus: Key.Minus, Equal: Key.Equal,
  BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket,
  Backslash: Key.Backslash, Semicolon: Key.Semicolon, Quote: Key.Quote,
  Comma: Key.Comma, Period: Key.Period, Slash: Key.Slash, Backquote: Key.Grave,
  // Numpad
  Numpad0: Key.NumPad0, Numpad1: Key.NumPad1, Numpad2: Key.NumPad2, Numpad3: Key.NumPad3,
  Numpad4: Key.NumPad4, Numpad5: Key.NumPad5, Numpad6: Key.NumPad6, Numpad7: Key.NumPad7,
  Numpad8: Key.NumPad8, Numpad9: Key.NumPad9,
  NumpadAdd: Key.Add, NumpadSubtract: Key.Subtract, NumpadMultiply: Key.Multiply,
  NumpadDivide: Key.Divide, NumpadDecimal: Key.Decimal, NumpadEnter: Key.Enter,
};

function mapKey(code, key) {
  if (codeMap[code]) return codeMap[code];
  // Fallback: single-character keys can be sent through via uppercase letter map.
  if (key && key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return codeMap['Key' + upper];
    if (upper >= '0' && upper <= '9') return codeMap['Digit' + upper];
  }
  return null;
}

module.exports = { dispatchInput, setBaseDisplay };
