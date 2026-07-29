/**
 * Cooperative scheduling — keep the UI responsive during large imports.
 */

/** @returns {Promise<void>} */
export function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Yield every `every` items in a loop body.
 * @param {number} index
 * @param {number} [every=25]
 */
export async function yieldEvery(index, every = 25) {
  if (index > 0 && index % every === 0) await yieldToMain();
}
