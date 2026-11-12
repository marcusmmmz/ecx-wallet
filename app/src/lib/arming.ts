/**
 * How long an approval must have been in view before it takes an approving click. A site picks
 * when its approval appears (and, over the Apps view, exactly where), so it could time one under a
 * click meant for something else; this is also how long the screen's sections take to rise into
 * place (app.css), so nothing is approved before it can be read.
 */
export const ARM_MS = 700;

/**
 * Tells `armed` false now and whenever the page is hidden, and true once it has been visible for
 * `ARM_MS` without a break. Returns the undo. Restart it (undo, call again) when what's shown changes.
 */
export function armWhenSeen(armed: (on: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restart = () => {
    clearTimeout(timer);
    armed(false);
    if (document.visibilityState === "visible") timer = setTimeout(() => armed(true), ARM_MS);
  };
  restart();
  document.addEventListener("visibilitychange", restart);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", restart);
  };
}
