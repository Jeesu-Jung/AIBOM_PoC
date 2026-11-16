const INTERACTIVE = "button, a, input, select, textarea";

/**
 * onClick for a <label> that wraps more than its input (source chips, evidence links).
 *
 * A click on a label's empty space activates its first control. Once chips sit above the input
 * that would be the first chip, so a stray click picked a research value. Send such clicks to the
 * input instead; clicks on a control itself are left alone.
 */
export function focusInputOnLabelClick(event) {
  if (event.target.closest(INTERACTIVE)) return;
  event.preventDefault();
  event.currentTarget.querySelector("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus();
}
