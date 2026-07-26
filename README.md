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


## OCR mejorado
Esta versión incorpora:
- Recorte automático de márgenes blancos.
- Ampliación del comprobante antes del OCR.
- Tres variantes de imagen: normalizada, enfocada y blanco/negro.
- Varias pasadas de OCR con diferentes modos de lectura.
- Extracción directa del texto cuando el PDF es digital.
- Reconocimiento más tolerante de RUC, serie, número, fecha, base imponible, IGV y total.

### Recomendaciones
- El comprobante debe ocupar la mayor parte de la imagen.
- Evita capturas donde el documento se vea muy pequeño.
- Para PDF escaneado, la primera página debe contener el comprobante.
- La información detectada debe revisarse antes de guardarse.


# Versión IA real: requisito fundamental

Esta versión usa un modelo visual para leer el comprobante completo y devolver datos estructurados:
- Tipo de comprobante
- RUC
- Razón social
- Fecha
- Serie y número
- Base imponible
- IGV
- Total
- Moneda
- Porcentaje de confianza

Después llena automáticamente el formulario. Al pulsar **Guardar y generar asiento**:
- guarda el comprobante en el navegador;
- lo muestra en el historial;
- detecta duplicados;
- genera el asiento contable referencial;
- permite exportar CSV y TXT.

## Configuración obligatoria en Render

Sin esta configuración la aplicación volverá al OCR básico.

1. Abre el servicio `contascan-ia` en Render.
2. Entra a **Environment**.
3. Agrega:
   - Key: `OPENAI_API_KEY`
   - Value: tu clave de API
4. Opcional:
   - Key: `OPENAI_MODEL`
   - Value: `gpt-4.1-mini`
5. Guarda los cambios y espera el nuevo despliegue.

## Seguridad
Nunca coloques la clave en `public/app.js`, GitHub ni archivos visibles. Solo debe estar en las variables de entorno de Render.

## Guardado actual
Los registros se guardan con `localStorage`, por lo que quedan almacenados en el navegador y dispositivo que los registró. Para compartir un historial entre varios usuarios se necesita una base de datos en la nube; eso es una mejora posterior y no impide demostrar el flujo central del proyecto.


# ContaBot
Se añadió un asistente flotante con apariencia de pequeño robot.

Funciones:
- Responde preguntas sobre el uso de ContaScan IA.
- Explica RUC, IGV, base imponible, duplicados y exportaciones.
- Puede revisar los campos visibles del comprobante abierto.
- Explica el asiento contable de manera orientativa.
- Usa la misma variable `OPENAI_API_KEY` configurada para la lectura visual.

El asistente no sustituye la revisión de un contador ni realiza validaciones SUNAT por sí solo.
