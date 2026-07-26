# ContaScan IA — versión gratuita con Gemini

Esta versión reemplaza OpenAI por **Google Gemini API**.

## Funciones
- Lee facturas y boletas en imagen o PDF.
- Extrae RUC, razón social, fecha, serie, número, base imponible, IGV y total.
- Completa automáticamente el formulario.
- Guarda el comprobante en el navegador.
- Genera un asiento contable referencial.
- Incluye el asistente flotante ContaBot.
- Usa Tesseract como respaldo si Gemini no está configurado o no responde.

## Configuración en Render

Agrega estas variables en **Environment**:

```text
GEMINI_API_KEY=tu_clave_de_Google_AI_Studio
GEMINI_MODEL=gemini-2.5-flash
```

No agregues `OPENAI_API_KEY`: esta versión ya no usa OpenAI.

## Obtener la clave

1. Entra a Google AI Studio con tu cuenta.
2. Abre la opción para obtener una API key.
3. Crea una clave en un proyecto.
4. Copia la clave.
5. Pégala en Render como `GEMINI_API_KEY`.
6. No publiques la clave en GitHub.

## Prueba

Cuando la clave esté configurada, la aplicación mostrará:

```text
Gemini IA activa
Lectura gratuita configurada
```

Después:
1. Sube una factura o boleta.
2. Presiona el botón de lectura.
3. Revisa los datos detectados.
4. Presiona **Guardar y generar asiento**.
5. Abre ContaBot desde el pequeño robot ubicado en la esquina inferior derecha.

## Sobre el nivel gratuito

La aplicación utiliza el nivel gratuito disponible para determinados modelos de Gemini.
La cuota no es ilimitada y Google puede cambiar sus límites. Para un proyecto académico
y una cantidad moderada de pruebas normalmente es suficiente.

## Guardado

Los comprobantes se guardan con `localStorage`, es decir, en el navegador del dispositivo.
No se comparte la información entre diferentes computadoras.
