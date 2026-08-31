export class SecretRedactor {
  constructor(customPatterns = []) {
    this.patterns = [
      // Bearer tokens
      { name: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9_\-\.\~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
      // Private Keys
      {
        name: 'private_key',
        regex: /-----BEGIN\s+(?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED)?\s*PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED)?\s*PRIVATE\s+KEY-----/gi,
        replacement: '[REDACTED_PRIVATE_KEY]',
      },
      // Passwords in URLs
      {
        name: 'url_credentials',
        regex: /((?:postgres|mysql|redis|mongodb|amqp|https?):\/\/[^:\s]+:)([^@\s]+)(@)/gi,
        replacement: '$1[REDACTED]$3',
      },
      // Key-value pairs (JSON or env-like)
      {
        name: 'key_value_secrets',
        regex: /(["']?(?:password|secret|api_key|apikey|access_token|refresh_token|private_key|token|auth_token|client_secret)["']?\s*[:=]\s*["']?)([^"'\\,\s]{4,})(["']?)/gi,
        replacement: '$1[REDACTED]$3',
      },
      // Authorization headers
      {
        name: 'auth_header',
        regex: /(Authorization:\s*)([^\r\n]+)/gi,
        replacement: '$1[REDACTED]',
      },
      // Set-Cookie / Cookie session IDs
      {
        name: 'cookie_session',
        regex: /(session(?:_id)?|token|jwt)=([^;,\s]+)/gi,
        replacement: '$1=[REDACTED]',
      },
    ];

    for (const p of customPatterns) {
      if (typeof p === 'string') {
        this.patterns.unshift({ name: 'custom_literal', regex: new RegExp(escapeRegex(p), 'g'), replacement: '[REDACTED]' });
      } else if (p && p.regex) {
        this.patterns.unshift(p);
      }
    }
  }

  redactText(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    for (const { regex, replacement } of this.patterns) {
      result = result.replace(regex, replacement);
    }
    return result;
  }

  redactObject(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return this.redactText(obj);
    if (typeof obj === 'number' || typeof obj === 'boolean') return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item));
    }

    if (typeof obj === 'object') {
      const redacted = {};
      for (const [key, val] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (['password', 'secret', 'token', 'authorization', 'api_key', 'apikey', 'private_key'].some((s) => lowerKey.includes(s))) {
          redacted[key] = '[REDACTED]';
        } else {
          redacted[key] = this.redactObject(val);
        }
      }
      return redacted;
    }

    return obj;
  }
}

function escapeRegex(string) {
  return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}
