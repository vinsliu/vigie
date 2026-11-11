/**
 * Best-effort masking of secrets before any transcript text reaches the UI or the API.
 *
 * Transcripts contain whatever the session saw: `.env` files, command output, pasted keys.
 * This is a safety net for screenshots and screen sharing, not a guarantee: a secret that
 * matches none of the patterns below is shown as is.
 *
 * Two rules keep it safe to run on hostile text (a prompt-injected page can put anything in a transcript):
 * - the input is cut to MAX_SCAN characters first, since nothing past that is ever displayed;
 * - every pattern uses bounded repetition and a distinctive anchor, so its cost is linear in the input
 *   (an unbounded `[a-z]*` rescanned from every word boundary is quadratic: 80 KB took 1.7 s).
 */
const MASK = "[redacted]";

/** Longest text scanned. The UI never shows more than a few thousand characters of any text. */
export const MAX_SCAN = 65_536;

// Provider token formats: distinctive prefixes, so false positives are rare.
const TOKENS: RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,512}/g, // Anthropic / OpenAI style keys
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})/g, // GitHub
  /\bglpat-[A-Za-z0-9_-]{20,64}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bhf_[A-Za-z0-9]{30,64}/g, // Hugging Face
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g, // Slack
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,128}/g, // Slack webhook
  /\b(?:[sr]k|pk)_(?:live|test)_[A-Za-z0-9]{16,255}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,255}/g, // Stripe webhook secret
  /\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,64}/g, // SendGrid
  /\bSK[0-9a-f]{32}\b/g, // Twilio
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[A-Za-z0-9_-]{20,2048}/g, // Google OAuth access token
  /\b[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/g, // Discord bot token
  /\beyJ[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024}/g, // JWT
];

const KEYWORDS = "PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY";

const PRIVATE_KEY = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g;
const AUTH_HEADER = /\b(Bearer|Basic)\s{1,8}[A-Za-z0-9._~+/=-]{16,4096}/gi;
// scheme://user:password@host (the scheme is anchored at the start of its run, so it cannot be rescanned)
const URL_CREDENTIALS = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,128}:)[^\s@/]{1,256}@/gi;
// --password value, --token=value, curl -u user:password
const CLI_FLAG = new RegExp(`(--(?:password|passwd|pass|secret|token|api-?key|access-?key|auth-?token)(?:=|\\s+))(?!-)\\S{4,256}`, "gi");
const CURL_USER = /(\s-u\s+[^\s:'"]{1,64}:)\S{3,256}/g;
// "password": "value" and password: 'value' (JSON, YAML, config dumps). The value is quoted, has no space, is at
// least 8 characters long and is not a plain word (it has a digit or a symbol, so "required" stays); the key must
// end with the keyword (so "tokenizer" is not a secret).
const QUOTED_ASSIGNMENT = new RegExp(
  `(["']?[A-Za-z0-9_-]{0,40}(?:${KEYWORDS})[A-Za-z0-9_-]{0,3}["']?\\s{0,3}[:=]\\s{0,3}["'])(?=[^"'\\s]{0,512}[^A-Za-z"'\\s])[^"'\\s]{8,512}(["'])`,
  "gi",
);
// NAME=value in the upper-case style of environment variables. The value needs a letter, so MAX_TOKENS=4096 stays.
const ENV_ASSIGNMENT = new RegExp(
  `\\b([A-Z0-9_]{0,40}(?:${KEYWORDS.replaceAll("[_-]?", "_?")})[A-Z0-9_]{0,40}=)(?=[^\\s"'\`;(){}\\[\\]<>]{0,512}[A-Za-z])[^\\s"'\`;(){}\\[\\]<>]{6,512}`,
  "g",
);
// name: value with no quotes. The value must contain a digit and be long, so prose such as "tokens: 169303" or
// "password: required" and code such as `password: Joi.string().min(8)` are left alone.
const LOOSE_ASSIGNMENT = new RegExp(
  `\\b([A-Za-z0-9_]{0,40}(?:${KEYWORDS})[A-Za-z0-9_]{0,40}\\s{0,3}[:=]\\s{0,3}["']?)(?=[^\\s"'\`,;(){}\\[\\]<>]{0,512}\\d)[^\\s"'\`,;(){}\\[\\]<>]{12,512}`,
  "gi",
);

export function redact(text: string): string {
  let out = text.length > MAX_SCAN ? `${text.slice(0, MAX_SCAN)}…` : text;
  out = out.replace(PRIVATE_KEY, `${MASK} private key`);
  for (const re of TOKENS) out = out.replace(re, MASK);
  out = out.replace(AUTH_HEADER, `$1 ${MASK}`);
  out = out.replace(URL_CREDENTIALS, `$1${MASK}@`);
  out = out.replace(CLI_FLAG, `$1${MASK}`);
  out = out.replace(CURL_USER, `$1${MASK}`);
  out = out.replace(QUOTED_ASSIGNMENT, `$1${MASK}$2`);
  out = out.replace(ENV_ASSIGNMENT, `$1${MASK}`);
  out = out.replace(LOOSE_ASSIGNMENT, `$1${MASK}`);
  return out;
}
