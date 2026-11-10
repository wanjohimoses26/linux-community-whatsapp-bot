// Optional: prints a password hash for ADMIN_PASSWORD_HASH. Most people can just set ADMIN_PASSWORD in Render instead.
// Usage: node scripts/hash-pass.js "my long passphrase"
import { hashPassword } from '../src/core/web-auth.js';
const password = process.argv[2];
if (!password || password.length < 8) { console.error('Usage: node scripts/hash-pass.js "a passphrase of 8+ characters"'); process.exit(1); }
console.log(hashPassword(password));
