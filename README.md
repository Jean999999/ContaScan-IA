# ContaScan IA v5 — lector Gemini robusto

## Cambio principal
Esta versión ya no oculta los errores de Gemini usando automáticamente un OCR defectuoso.

Cuando existe `GEMINI_API_KEY`:
1. Envía a Gemini la imagen original.
2. Envía también una versión mejorada.
3. Solicita JSON estructurado.
4. Prueba el modelo configurado y modelos alternativos compatibles.
5. Valida RUC, fecha, serie, número e importes.
6. Si Gemini falla, muestra el error real y NO rellena campos incorrectos.

## Variables de Render
Solo necesitas:

```text
GEMINI_API_KEY=tu_clave
GEMINI_MODEL=gemini-2.5-flash
```

## Actualización
1. Reemplaza los archivos de tu proyecto con esta carpeta.
2. Ejecuta:

```bash
git add .
git commit -m "Actualizar lector Gemini robusto v5"
git push origin main
```

3. Espera el despliegue de Render.
4. Abre la aplicación.
5. Pulsa **Probar conexión** en la tarjeta inferior izquierda.
6. Debe mostrar `Gemini conectado: gemini-2.5-flash`.
7. Sube una factura y pulsa **Leer con IA**.

## Diagnóstico directo
También puedes abrir:

```text
https://TU-APP.onrender.com/api/gemini-test
```

Debe devolver algo parecido a:

```json
{"ok":true,"model":"gemini-2.5-flash","answer":"CONEXION_OK"}
```

## Nota
La calidad depende de la resolución del comprobante y de la cuota disponible en Gemini.
La aplicación permite corregir los campos antes de guardar y los asientos son referenciales.
