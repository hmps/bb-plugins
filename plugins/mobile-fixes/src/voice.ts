// Voice input on touch screens:
//   1. Voice buttons work on the first tap. bb cancels pointerdown on the mic
//      button but not mousedown, and the recording buttons have no guard. On
//      iOS, mousedown moves focus out of the editor, the keyboard closes, and
//      the click misses. bb's submit button cancels both (onMouseDown:
//      preventDefault); this does the same for the voice buttons.
//   2. bb makes the editor read-only while it records, so the editor loses
//      focus, and bb does not focus it again after the transcript is
//      inserted, so the composer collapses. When the recording bar goes away,
//      focus the editor so the text shows.
//   3. voice.css keeps an empty editor from adding an empty row above the
//      recording bar.
import { COARSE_POINTER_QUERY, VOICE_CONTROLS_SELECTOR } from "./shared";
import "./voice.css";

// bb's voice buttons (composer mic, and the recording bar's stop/cancel).
const VOICE_BUTTON_SELECTOR = [
  'button[aria-label="Start voice input"]',
  'button[aria-label="Stop and transcribe recording"]',
  'button[aria-label="Cancel recording"]',
  'button[aria-label="Cancel transcription"]',
].join(",");

// Cancels the focus transfer of a press on a voice button, so the editor
// keeps focus and the keyboard stays open. The click still fires.
function keepEditorFocus(event: PointerEvent | MouseEvent) {
  if (event.button !== 0) return;
  if (!window.matchMedia(COARSE_POINTER_QUERY).matches) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest(VOICE_BUTTON_SELECTOR);
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  event.preventDefault();
}

// Watches for bb's recording bar and focuses its editor when it goes away
// (bb removes it after the transcript is inserted, or on cancel).
function watchVoiceEnd(signal: AbortSignal) {
  let recordingForm: HTMLFormElement | null = null;
  let frame = 0;
  const check = () => {
    frame = 0;
    const controls = document.querySelector(VOICE_CONTROLS_SELECTOR);
    if (controls) {
      recordingForm = controls.closest<HTMLFormElement>("form[data-promptbox]");
      return;
    }
    const form = recordingForm;
    recordingForm = null;
    if (!form?.isConnected || !window.matchMedia(COARSE_POINTER_QUERY).matches) return;
    const editor = form.querySelector<HTMLElement>(".ProseMirror");
    if (editor && document.activeElement !== editor) editor.focus({ preventScroll: true });
  };
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(check);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden"],
  });
  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
    { once: true },
  );
}

// Installs the voice fixes until `signal` aborts.
export function mountVoiceFixes(signal: AbortSignal) {
  const options = { capture: true, signal } as const;
  document.addEventListener("pointerdown", keepEditorFocus, options);
  document.addEventListener("mousedown", keepEditorFocus, options);
  watchVoiceEnd(signal);
}
