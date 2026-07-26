# ContaScan IA Pro

Aplicación web MVP basada en el proyecto académico ContaScan IA.

## Qué incluye
- Interfaz moderna y adaptable a celular.
- Lectura OCR con inteligencia artificial mediante Tesseract.js.
- Extracción automática de RUC, fecha, serie, número, base imponible, IGV y total.
- Detección de comprobantes duplicados.
- Generación de asiento contable referencial con cuentas del PCGE.
- Registro local en el navegador.
- Exportación a CSV y TXT.
- Acceso directo a consulta RUC de SUNAT.

## Requisitos
- Node.js 18 o superior.
- Conexión a internet durante la primera instalación de dependencias.

## Instalación
1. Descomprime la carpeta.
2. Abre una terminal dentro de la carpeta.
3. Ejecuta:
   npm install
4. Luego ejecuta:
   npm start
5. Abre en el navegador:
   http://localhost:3000

## Importante
- Esta versión procesa imágenes JPG, PNG o WEBP.
- El OCR es real, pero la exactitud depende de la calidad de la imagen.
- La validación automática con SUNAT no está implementada porque requiere una integración autorizada.
- Los asientos son referenciales y deben ser revisados por un contador.
- Los datos se guardan localmente en el navegador.

## Versión PDF
Acepta PDF, JPG, PNG y WEBP. Los PDF se convierten en el navegador y se procesa la primera página.
