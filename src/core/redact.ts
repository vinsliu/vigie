/**
 * Best-effort masking of secrets before any transcript text reaches the UI or the API.
 *
 * Transcripts contain whatever the session saw: `.env` files, command output, pasted keys.
 * This is a safety net for screenshots and screen sharing, not a guarantee: a secret that
 * matches none of the patterns below is shown as is.
 */
const MASK = "[redacted]";

// Provider token formats: distinctive prefixes, so false positives are rare.
const TOKENS: RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, // Anthropic / OpenAI style keys
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, // GitHub
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:[sr]k|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}/g, // Stripe webhook secret
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
// scheme://user:password@host
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;
// NAME=value where NAME looks like a secret. The value must contain a digit and be long enough,
// so prose such as "tokens: 169303" or "password: required" is left alone; brackets and
// parentheses are excluded so code like `password: Joi.string().min(8)` is not mistaken for a value.
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?)(?=[^\s"'`,;(){}[\]<>]*\d)[^\s"'`,;(){}[\]<>]{12,}/gi;

export function redact(text: string): string {
  let out = text.replace(PRIVATE_KEY, `${MASK} private key`);
  for (const re of TOKENS) out = out.replace(re, MASK);
  out = out.replace(AUTH_HEADER, `$1 ${MASK}`);
  out = out.replace(URL_CREDENTIALS, `$1${MASK}@`);
  out = out.replace(ASSIGNMENT, `$1${MASK}`);
  return out;
}
