/**
 * ⌘S / Ctrl+S, pointed at the app instead of the browser.
 *
 * Every one of these apps saves itself — to localStorage, to Firestore, to a
 * file on disk — and none of them has a Save button. Hands remember ⌘S anyway,
 * and in a browser that opens the "Save page as…" dialog, which is the wrong
 * answer to a question the app could answer.
 *
 * `interceptSave` swallows the shortcut and, if asked, runs the app's own save
 * and shows the words the app hands back in a small toast. Nothing else: no
 * dependencies, no framework, no theme to match — a dark pill at the edge of
 * the screen that reads fine over any of the sites it lives on.
 *
 * Two ways in:
 *
 *   // Vite / npm — "cmd-s": "github:mred-randomprojects/cmd-s#v1.0.0"
 *   import { interceptSave } from "cmd-s";
 *   interceptSave({ onSave: () => { flush(); return "Saved"; } });
 *
 *   // A single HTML file
 *   <script type="module">
 *     import { interceptSave } from "https://cdn.jsdelivr.net/gh/mred-randomprojects/cmd-s@1.0.0/dist/cmd-s.js";
 *     interceptSave({ onSave: () => "Guardado" });
 *   </script>
 */
/**
 * ⌘S on a Mac, Ctrl+S everywhere else. Both are accepted on every platform:
 * a Mac on an external keyboard has both keys and a hand hits whichever it
 * remembers.
 *
 * ⇧ and ⌥ are left alone. ⌘⇧S is "Save As" in some browsers and nothing in
 * others, and a shortcut that means something different per browser is not
 * one worth taking over. `key` is checked in both cases so that Caps Lock —
 * which uppercases the key without setting `shiftKey` — does not lock the
 * shortcut out.
 */
export function isSaveShortcut(e) {
    if (!(e.metaKey || e.ctrlKey))
        return false;
    if (e.altKey || e.shiftKey)
        return false;
    return e.key === "s" || e.key === "S";
}
/**
 * Only keyboard events are ever dispatched as "keydown", but the listener is
 * typed against `Event` so a plain `EventTarget` can stand in for `window`
 * under Node — so the fields are checked for rather than assumed.
 */
function isKeyEvent(e) {
    return "key" in e && typeof e.key === "string" && "metaKey" in e;
}
/**
 * Take over ⌘S / Ctrl+S on the page. Returns the function that gives it back.
 *
 * The browser's default is prevented on every press of the shortcut, even the
 * ones that do not reach `onSave`: a held key auto-repeats, and one dialog on
 * the third repeat would be as bad as one on the first. What does *not* reach
 * `onSave` is a repeat, a press while a previous save is still in flight, and
 * a press some component already claimed with `preventDefault` — a text editor
 * with its own idea of ⌘S, say — since a listener on `window` runs last and
 * should defer to whatever was closer to the keystroke.
 */
export function interceptSave(options = {}) {
    const { onSave, duration, position } = options;
    const target = options.target ?? window;
    let inFlight = false;
    function report(error) {
        console.error("[cmd-s] save failed:", error);
    }
    function onKeyDown(e) {
        if (e.defaultPrevented || !isKeyEvent(e) || e.isComposing)
            return;
        if (!isSaveShortcut(e))
            return;
        e.preventDefault();
        if (e.repeat || onSave === undefined || inFlight)
            return;
        let result;
        try {
            result = onSave();
        }
        catch (error) {
            report(error);
            return;
        }
        inFlight = true;
        void Promise.resolve(result)
            .then((message) => {
            if (typeof message === "string" && message !== "") {
                showToast(message, { duration, position });
            }
        }, report)
            .finally(() => {
            inFlight = false;
        });
    }
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
}
// ─── The toast ──────────────────────────────────────────────────────────────
const CLASS = "cmd-s-toast";
const CSS = `
.${CLASS} {
  position: fixed;
  left: 50%;
  z-index: 2147483647;
  box-sizing: border-box;
  max-width: min(90vw, 420px);
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  background: rgba(24, 24, 27, 0.92);
  color: #fafafa;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.01em;
  text-align: center;
  white-space: pre-line;
  pointer-events: none;
  opacity: 0;
  transform: translate(-50%, var(--cmd-s-offset));
  transition: opacity 160ms ease, transform 160ms ease;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
.${CLASS}[data-position="bottom"] {
  bottom: max(16px, env(safe-area-inset-bottom));
  --cmd-s-offset: 8px;
}
.${CLASS}[data-position="top"] {
  top: max(16px, env(safe-area-inset-top));
  --cmd-s-offset: -8px;
}
.${CLASS}[data-shown="true"] {
  opacity: 1;
  transform: translate(-50%, 0);
}
@media (prefers-reduced-motion: reduce) {
  .${CLASS} { transition: none; }
}
`;
/** How long the hide transition takes; the text is cleared once it is over. */
const HIDE_MS = 200;
let toast = null;
let hideTimer = null;
let clearTimer = null;
function ensureToast() {
    if (toast !== null && toast.isConnected)
        return toast;
    if (document.querySelector(`style[data-${CLASS}]`) === null) {
        const style = document.createElement("style");
        style.setAttribute(`data-${CLASS}`, "");
        style.textContent = CSS;
        document.head.appendChild(style);
    }
    const el = document.createElement("div");
    el.className = CLASS;
    // A live region only announces changes made inside one that is already on
    // the page, so the element stays mounted (invisible) between toasts.
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.dataset.shown = "false";
    document.body.appendChild(el);
    // Flush styles before the first show so it fades in rather than popping.
    void getComputedStyle(el).opacity;
    toast = el;
    return el;
}
/**
 * Show a short message at the edge of the screen. One toast at a time: a
 * second call while the first is up replaces its text and restarts the clock.
 *
 * A no-op without a `document`, so a module that calls this can still be
 * imported and tested under Node.
 */
export function showToast(message, options = {}) {
    if (typeof document === "undefined")
        return;
    const { duration = 1800, position = "bottom" } = options;
    const el = ensureToast();
    if (hideTimer !== null)
        clearTimeout(hideTimer);
    if (clearTimer !== null)
        clearTimeout(clearTimer);
    el.dataset.position = position;
    el.textContent = message;
    el.dataset.shown = "true";
    hideTimer = setTimeout(() => {
        hideTimer = null;
        el.dataset.shown = "false";
        // Stale text in a hidden live region is still text a screen reader can
        // land on; clear it once the pill has faded.
        clearTimer = setTimeout(() => {
            clearTimer = null;
            el.textContent = "";
        }, HIDE_MS);
    }, duration);
}
