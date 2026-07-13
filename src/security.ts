import crypto from 'crypto';

/**
 * Verifica la firma HMAC SHA256 de un webhook de Conekta.
 * Esto asegura que el webhook provenga legítimamente de Conekta.
 */
export function verifyConektaSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const hash = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return hash === signature;
}

/**
 * Genera y firma un token JWT para un comando enviado al dispositivo (MDM).
 * Esto garantiza que el comando sea auténtico e inmutable.
 */
import jwt from 'jsonwebtoken';

export function generateMdmCommandToken(deviceId: string, action: 'LOCK' | 'UNLOCK', secret: string): string {
  const payload = {
    deviceId,
    action,
    timestamp: Date.now()
  };
  // Expiración rápida de 5 minutos para prevenir ataques de replay
  return jwt.sign(payload, secret, { expiresIn: '5m' });
}
