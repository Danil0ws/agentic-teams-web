import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

export interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

export interface JwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  serviceurl?: string;
  appid?: string;
  tid?: string;
  [key: string]: unknown;
}

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

const OPENID_METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const ALLOWED_ISSUERS = ['https://api.botframework.com'];

export interface VerifyOptions {
  appId: string;
  /** serviceUrl da Activity: o token do Bot Framework carrega esse claim. */
  serviceUrl?: string;
  /** Injeção para teste: substitui a busca de JWKS. */
  keys?: Jwk[];
  now?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  payload?: JwtPayload;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

let cache: { fetchedAt: number; keys: Jwk[] } | undefined;

/** Busca (e cacheia por 24h) as chaves públicas do Bot Framework. */
export async function fetchBotFrameworkKeys(now = Date.now()): Promise<Jwk[]> {
  if (cache && now - cache.fetchedAt < 24 * 60 * 60 * 1000) return cache.keys;
  const metadata = (await (await fetch(OPENID_METADATA)).json()) as { jwks_uri?: string };
  if (!metadata.jwks_uri) throw new Error('openidconfiguration sem jwks_uri');
  const jwks = (await (await fetch(metadata.jwks_uri)).json()) as { keys?: Jwk[] };
  if (!jwks.keys?.length) throw new Error('JWKS vazio');
  cache = { fetchedAt: now, keys: jwks.keys };
  return jwks.keys;
}

/**
 * Valida um Bearer token do Azure Bot Service como o botbuilder faz:
 * assinatura RS256 pela JWKS pública, iss, aud (App ID), exp/nbf e o claim
 * serviceurl. Sem isso, qualquer um poderia postar no endpoint /api/messages.
 */
export async function verifyBotFrameworkToken(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'token malformado' };
  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = decodeSegment<JwtHeader>(parts[0]);
    payload = decodeSegment<JwtPayload>(parts[1]);
  } catch {
    return { ok: false, reason: 'header/payload não são JSON válido' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: `alg não permitido: ${header.alg}` };

  let keys: Jwk[];
  try {
    keys = options.keys ?? (await fetchBotFrameworkKeys(options.now));
  } catch (error) {
    return { ok: false, reason: `não foi possível obter JWKS: ${(error as Error).message}` };
  }
  // kid presente no header tem que existir na JWKS: cair para a primeira chave
  // mascararia token de outra emissão ("chave inválida" em vez de motivo real).
  const jwk = header.kid ? keys.find((candidate) => candidate.kid === header.kid) : keys[0];
  if (!jwk) return { ok: false, reason: `kid não encontrado na JWKS: ${header.kid}` };

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = jwk.x5c?.[0]
      ? createPublicKey({ key: Buffer.from(jwk.x5c[0], 'base64'), format: 'der', type: 'spki' })
      : createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  } catch (error) {
    return { ok: false, reason: `chave inválida: ${(error as Error).message}` };
  }

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const signatureOk = verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'));
  if (!signatureOk) return { ok: false, reason: 'assinatura inválida' };

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSeconds - 300) return { ok: false, reason: 'token expirado' };
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + 300) return { ok: false, reason: 'token ainda não válido (nbf)' };
  if (payload.iss && !ALLOWED_ISSUERS.includes(payload.iss)) return { ok: false, reason: `issuer não permitido: ${payload.iss}` };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (options.appId && !audiences.some((aud) => aud && safeEqual(aud, options.appId))) return { ok: false, reason: 'audience não corresponde ao App ID' };
  if (options.serviceUrl && payload.serviceurl && !safeEqual(payload.serviceurl.replace(/\/$/, ''), options.serviceUrl.replace(/\/$/, ''))) {
    return { ok: false, reason: 'claim serviceurl não corresponde à Activity' };
  }
  return { ok: true, payload };
}

/** Usado só pelos testes: zera o cache de JWKS. */
export function resetKeyCache(): void {
  cache = undefined;
}
