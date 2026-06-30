import { randomBytes } from 'crypto';
import * as dns from 'dns';

/**
 * Domain-ownership verification (H-3).
 *
 * A tenant who adds `victim.com` must prove control before the platform will
 * route it through Caddy, issue a cert for it, or stand up a mail stack — else
 * any tenant could pre-empt/squat a hostname they don't own and (once DNS
 * points at the platform) obtain a valid LE cert and serve content under the
 * victim's name. Proof = publishing a DNS TXT record:
 *
 *   _dockcontrol-verify.<domain>   TXT   "dockcontrol-verify=<token>"
 *
 * (we also accept the token on the apex/host TXT itself, for providers that
 * make the underscore-prefixed name awkward).
 */

/** The DNS label we look for the TXT record under. */
export const VERIFY_TXT_PREFIX = '_dockcontrol-verify';
/** The value prefix inside the TXT record. */
export const VERIFY_VALUE_PREFIX = 'dockcontrol-verify=';

/** Mint a fresh verification token (URL-safe, 32 bytes of entropy). */
export function newVerificationToken(): string {
  return randomBytes(24).toString('base64url');
}

/** The exact TXT record name + value the user must publish. */
export function verificationRecord(domain: string, token: string): { name: string; value: string } {
  return {
    name: `${VERIFY_TXT_PREFIX}.${domain}`,
    value: `${VERIFY_VALUE_PREFIX}${token}`,
  };
}

/** True when any TXT row carries our exact token value. */
export function txtContainsToken(txtRecords: string[][] | null | undefined, token: string): boolean {
  if (!txtRecords) return false;
  const want = `${VERIFY_VALUE_PREFIX}${token}`;
  for (const chunks of txtRecords) {
    // A TXT value can be split into multiple strings; join them.
    const joined = chunks.join('').trim();
    if (joined === want) return true;
  }
  return false;
}

/**
 * Resolve the verification TXT for a domain against public resolvers and check
 * for the token. Looks under `_dockcontrol-verify.<domain>` first, then the
 * bare `<domain>` as a fallback. Returns true when the token is found.
 *
 * `resolverFactory` is injectable so tests can stub DNS without network.
 */
export async function checkDomainVerification(
  domain: string,
  token: string,
  resolverFactory: () => { resolveTxt: (h: string) => Promise<string[][]> } = defaultResolver,
): Promise<boolean> {
  const resolver = resolverFactory();
  const safe = async (h: string): Promise<string[][] | null> => {
    try {
      return await resolver.resolveTxt(h);
    } catch {
      return null;
    }
  };
  const prefixed = await safe(`${VERIFY_TXT_PREFIX}.${domain}`);
  if (txtContainsToken(prefixed, token)) return true;
  const apex = await safe(domain);
  return txtContainsToken(apex, token);
}

function defaultResolver(): { resolveTxt: (h: string) => Promise<string[][]> } {
  const r = new dns.promises.Resolver();
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return { resolveTxt: (h: string) => r.resolveTxt(h) };
}
