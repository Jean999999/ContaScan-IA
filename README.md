# ContaScan IA — Proyecto final actualizado

Aplicación web para cargar comprobantes peruanos, extraer sus datos con Google Gemini, revisar y guardar la información, generar un asiento contable referencial y consultar el historial.

## Funciones principales

- Lectura de JPG, PNG, WEBP y PDF; el PDF se convierte en el navegador.
- Extracción de RUC del emisor, razón social, fecha, serie, número, subtotal, IGV, total y moneda.
- Selección automática de un modelo Gemini compatible con `generateContent`.
- Modelos de respaldo actuales: `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.5-flash` y `gemini-3.1-flash-lite`.
- Uso del endpoint estable `v1` de Gemini para generar contenido.
- Diagnóstico disponible en `/api/gemini-test`.
- Edición y guardado local de comprobantes.
- Detección de duplicados.
- Generación de asiento contable referencial con cuentas frecuentes del PCGE.
- Exportaciones y ContaBot.
- OCR manual de respaldo cuando Gemini no esté configurado o el usuario lo solicite.

## Archivos que debes subir a GitHub

Sube directamente el contenido de esta carpeta:

- `server.js`
- `package.json`
- `.gitignore`
- `README.md`
- carpeta `public`

No subas `node_modules`.

## Despliegue en Render

1. Reemplaza los archivos anteriores del repositorio por los archivos de esta carpeta.
2. En Render conserva `GEMINI_API_KEY` con tu clave de Google AI Studio.
3. Elimina `GEMINI_MODEL` para permitir la selección automática.
4. Build command: `npm install`
5. Start command: `npm start`
6. Ejecuta `Manual Deploy` y selecciona `Deploy latest commit`.
7. Cuando aparezca `Live`, abre `/api/gemini-test`.

El modelo exacto puede variar según los modelos habilitados para la clave.

## Importante

La lectura depende de la disponibilidad y cuota de Gemini. Los campos extraídos y los asientos contables deben revisarse antes de utilizarse.
