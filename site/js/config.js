/* Public runtime configuration for the Company Swag Vote 2026 ballot.
 *
 * This file ships to GitHub Pages and is world-readable. Never put secrets,
 * admin tokens, or credentials here — only public values.
 *
 * VOTE_API_URL — the public base URL of the deployed Cloudflare Worker, with
 * no trailing slash, e.g. 'https://swag-vote-api.<your-subdomain>.workers.dev'.
 * Leave it blank until the Worker in ../worker is deployed; while blank the
 * ballot renders and can be filled in, but submitting shows a clear
 * "voting endpoint not configured" message and no vote-lock is stored.
 */
window.SWAG_VOTE_CONFIG = {
  VOTE_API_URL: '',
};
