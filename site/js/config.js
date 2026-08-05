/* Public runtime configuration for the Company Swag Vote 2026 ballot.
 *
 * This file ships to GitHub Pages and is world-readable. Never put secrets,
 * admin tokens, or credentials here — only public values.
 *
 * VOTE_API_URL — the public base URL of the deployed Cloudflare Worker, with
 * no trailing slash, e.g. 'https://swag-vote-api.<your-subdomain>.workers.dev'.
 * This public URL is safe to publish. The private administrator token stays
 * only in the Cloudflare Worker secret store.
 */
window.SWAG_VOTE_CONFIG = {
  VOTE_API_URL: 'https://company-swag-vote-2026-api.nishhbt.workers.dev',
};
