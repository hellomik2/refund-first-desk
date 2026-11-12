// What the page says when an action fails. Pure, so the tests can read it.
// The hosted server runs on Render's free plan: when it sleeps and wakes, it forgets every workspace, so a tab
// left open sends its next click to a workspace the server no longer has. That message stays on screen.

/** @returns {{text: string, stays: boolean, restart: boolean}} */
export function failureView(err = {}) {
  if (err.code === 'BAD_WORKSPACE') {
    return { text: 'This workspace is gone: the demo server restarted after a quiet spell and forgot it. Nothing was charged by this click. Start a fresh workspace to try again.', stays: true, restart: true };
  }
  return { text: err.message || 'Something went wrong. Try again.', stays: false, restart: false };
}
