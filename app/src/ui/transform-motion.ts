export function afterNextPaint(callback: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(callback);
  });
  return () => cancelAnimationFrame(frame);
}

export const afterStartStatePaints = afterNextPaint;

export function movingTransform(element: HTMLElement | undefined): boolean {
  if (element === undefined || typeof element.getAnimations !== "function")
    return false;
  return element
    .getAnimations()
    .some(
      (animation) =>
        animation.playState === "running" &&
        (animation as CSSTransition).transitionProperty === "transform",
    );
}
