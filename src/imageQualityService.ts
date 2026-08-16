import sharp from 'sharp';

// Kernel Laplaciano estándar para detección de bordes (blur detection). Su suma es 0,
// así que sharp necesita `scale: 1` explícito (si no, intenta dividir por la suma y falla).
const KERNEL_LAPLACIANO = [
  -1, -1, -1,
  -1, 8, -1,
  -1, -1, -1
];

export class ImageQualityService {
  // Umbrales calibrados 2026-08-15 contra fotos reales de producción (10 INE + 5
  // selfies, incluida la solicitud 5342f63b cuyo INE frente salió borroso/oscuro y
  // se había auto-aprobado igual): las fotos buenas dieron varianza 1600-14300 y
  // brillo 96-165; la foto mala dio varianza 987 y brillo 77. Umbrales puestos con
  // margen debajo del mínimo "bueno" observado, no un valor genérico de tutorial —
  // si en el futuro rechaza fotos legítimas o deja pasar malas, recalibrar con una
  // muestra más grande en vez de ajustar a ciegas.
  private static UMBRAL_VARIANZA_MINIMA = 1200;
  private static BRILLO_MINIMO = 80;

  static async evaluarCalidad(base64DataUrl: string): Promise<{ nitida: boolean; varianza: number; brillo: number }> {
    try {
      const match = base64DataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      const buffer = Buffer.from(match ? match[1] : base64DataUrl, 'base64');

      const grises = sharp(buffer).greyscale();

      const [statsBrillo, statsBordes] = await Promise.all([
        grises.clone().stats(),
        grises.clone().convolve({ width: 3, height: 3, kernel: KERNEL_LAPLACIANO, scale: 1 }).stats()
      ]);

      const brillo = statsBrillo.channels[0].mean;
      const varianza = statsBordes.channels[0].stdev ** 2;

      return {
        varianza,
        brillo,
        nitida: varianza >= this.UMBRAL_VARIANZA_MINIMA && brillo >= this.BRILLO_MINIMO
      };
    } catch (error: any) {
      console.error('[ImageQuality] No se pudo evaluar la calidad de la imagen, se trata como no nítida:', error.message);
      return { nitida: false, varianza: 0, brillo: 0 };
    }
  }
}
