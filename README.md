# Lector MD

PWA para leer, escuchar y editar archivos Markdown en Android. Funciona sin conexión, se instala como app y aparece en el menú **Compartir** del celular.

## Qué hace

- **Render completo**: tablas desplazables, código con resaltado, listas de tareas que se marcan tocándolas, diagramas Mermaid, front matter, índice de títulos, modo claro/oscuro.
- **Leer en voz alta**: reproductor con anterior/siguiente, velocidad (0.8× a 2×), resaltado del párrafo que se está leyendo y "toca un párrafo para leer desde ahí". Elige voz en español o inglés según el idioma del documento (o la que fijes en Ajustes). Recuerda dónde quedaste.
- **Biblioteca**: recientes, agrupación por carpeta/repositorio, búsqueda en títulos y contenido. Se guarda en el celular (IndexedDB).
- **Editar y guardar**: editor con barra de formato y vista previa, borrador automático. Al guardar:
  - Archivo del celular abierto con el selector del sistema → se escribe sobre el original (si Chrome lo permite) o queda en la biblioteca y puedes exportar una copia.
  - GitHub → crea un commit.
  - Google Drive → actualiza el archivo.
- **Orígenes**: archivos o carpetas del celular, repositorios de GitHub (públicos sin token; privados con token), Google Drive, y archivos compartidos desde otras apps.

## Publicar en GitHub Pages

1. Crea un repositorio, por ejemplo `lector-md`, y sube **el contenido de esta carpeta** a la raíz (que `index.html` quede en la raíz del repo).
2. En el repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)` → **Save**.
3. Espera 1–2 minutos. La app queda en `https://<tu-usuario>.github.io/lector-md/`.

No hay paso de compilación: son archivos estáticos.

## Instalar en Android

1. Abre la URL en **Chrome**.
2. Menú ⋮ → **Instalar app** (o **Agregar a pantalla principal**).
3. Ábrela desde el ícono. Desde ese momento:
   - Funciona sin conexión.
   - En el administrador de archivos, mantén presionado un `.md` → **Compartir → Lector MD** y se abre directo.

Android no deja que una PWA aparezca en "Abrir con"; la ruta es **Compartir**.

## GitHub

Sin token: lees repositorios públicos (límite de 60 consultas por hora).

Para repos privados y para guardar como commit:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access**: solo los repos que quieras.
3. **Permissions → Repository permissions → Contents: Read and write**.
4. Pega el token en **Ajustes → GitHub** de la app. Se guarda solo en el celular.

## Google Drive (configuración única)

Drive exige un Client ID de OAuth propio:

1. Entra a <https://console.cloud.google.com/> y crea un proyecto (por ejemplo `lector-md`).
2. **APIs y servicios → Biblioteca** → busca **Google Drive API** → **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth** (Google Auth Platform):
   - Tipo de usuario: **Externo**.
   - Nombre de la app, correo de soporte y de contacto: los tuyos.
   - En **Público / Usuarios de prueba**, agrega tu propio correo de Gmail.
   - Deja la app en modo **Prueba** (Testing). No hace falta verificación.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo: **Aplicación web**.
   - **Orígenes autorizados de JavaScript**: `https://<tu-usuario>.github.io` (sin la ruta del repo, sin `/` final).
   - No necesitas URIs de redirección.
5. Copia el **ID de cliente** (`…apps.googleusercontent.com`) y pégalo en **Ajustes → Google Drive** de la app.

La primera vez Google mostrará "Google no verificó esta app": es esperado en modo prueba. Toca **Continuar**. El acceso dura una hora y se renueva al volver a usar Drive.

## Limitaciones conocidas

- **Voz con pantalla apagada**: Chrome puede pausar la lectura si bloqueas el celular. Por eso existe la opción "Mantener la pantalla encendida mientras lee".
- **Voces**: usa las del motor de texto a voz de Android (Ajustes → Sistema → Idiomas → Salida de texto a voz). Si no suena, instala o actualiza "Servicios de voz de Google".
- **Guardar sobre el archivo original del celular** depende de que el Chrome del celular soporte el selector de archivos moderno (File System Access). Si no, el documento queda en la biblioteca y usas **⋮ → Guardar una copia .md**.
- **Imágenes de repos privados** no cargan (GitHub exige autenticación para servirlas).

## Estructura

```
index.html            interfaz
app.css               estilos (tema claro/oscuro)
js/main.js            rutas, biblioteca, lector, editor, ajustes
js/render.js          Markdown → HTML (marked + DOMPurify + highlight.js + Mermaid)
js/tts.js             lectura en voz alta (Web Speech API)
js/github.js          API REST de GitHub
js/drive.js           Google Drive (Google Identity Services)
js/files.js           archivos del celular
js/db.js              IndexedDB
sw.js                 offline + recepción de archivos compartidos
manifest.webmanifest  instalación y share target
vendor/, fonts/       librerías y tipografía Literata incluidas para uso offline
```

Para publicar cambios: edita, sube la versión nueva de `VERSION` en `sw.js` y haz commit. La app instalada avisa que hay versión nueva.
