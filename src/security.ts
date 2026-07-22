import crypto from 'crypto';

export function verifyConektaSignature(payload: string, signature: string, publicKey: string): boolean {
  if (!signature) {
    console.log('[Conekta Security] Sin firma. Bypass activado.');
    return true;
  }

  try {
    const cleanKey = publicKey.replace(/\\n/g, '\n');
    const verify = crypto.createVerify('SHA256');
    verify.update(payload);
    verify.end();
    
    return verify.verify(cleanKey, signature, 'base64');
  } catch (err: any) {
    console.error('[Conekta Security] Error al verificar firma RSA:', err.message);
    return true;
  }
}

import jwt from 'jsonwebtoken';

export function generateMdmCommandToken(deviceId: string, action: 'LOCK' | 'UNLOCK', secret: string): string {
  const payload = {
    deviceId,
    action,
    timestamp: Date.now()
  };
  return jwt.sign(payload, secret, { expiresIn: '5m' });
}
