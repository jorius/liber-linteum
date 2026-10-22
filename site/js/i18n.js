// All of the site's copy, in English and Latin-American Spanish. The HTML carries the keys
// (data-i18n, data-i18n-html, data-i18n-attr) with the English text inline, so the page reads
// without JavaScript. Both languages must have exactly the same keys (checked by the tests).

export const LANGS = ['en', 'es'];

export const dict = {
  en: {
    'meta.title': 'Liber Linteum: private notes that stay on your machine',
    'meta.description':
      'A free, open-source notes app. Plain Markdown files in a folder you own, a canvas of cards that shows how they connect, and no cloud, accounts or telemetry.',
    'meta.ogDescription':
      'Private, local-only notes: plain Markdown in a folder you own. No cloud, no accounts, no telemetry.',
    skip: 'Skip to content',
    'brand.label': 'Liber Linteum, back to the top',
    'nav.label': 'Sections',
    'nav.bring': 'Bring your notes',
    'nav.features': 'Features',
    'nav.privacy': 'Privacy',
    'nav.download': 'Download',
    'nav.vault': 'Sample vault',
    'nav.roadmap': 'Roadmap',
    'nav.support': 'Support',
    'nav.sponsor': 'Sponsor',
    'lang.label': 'Language',

    'hero.kicker': 'Private notes · free and open source',
    'hero.lead':
      'Your notes are plain Markdown files in a folder you own. A canvas of cards shows how they connect. Nothing leaves your machine.',
    'hero.downloadFor': 'Download for {os}',
    'hero.tryVault': 'Try the sample vault',
    'hero.compat': 'Opens Obsidian vaults · Imports from Notion',
    'hero.pledge':
      'No\u00a0cloud · No\u00a0accounts · No\u00a0telemetry · 0\u00a0network\u00a0requests',

    'clip.hero':
      'The Global View: a folder expanded in place, a drill-down, a page’s atoms, then a quick edit in Live Preview.',
    'clip.obsidian':
      'Choosing Open an Obsidian vault, then the vault as Obsidian left it: callouts, embeds, wikilinks and its attachment setting.',
    'clip.notion': 'A Notion export being imported: pages, nested pages and a database as a table.',
    'clip.globalView': 'Cards in the Global View expanding in place to show a folder’s pages.',
    'clip.atoms':
      'A page’s atoms in the Global View: its sections and blocks as a tree of small cards.',
    'clip.editor':
      'A page being written in Live Preview, with a callout and a block dragged into place.',
    'clip.maths':
      'Split view: a page’s LaTeX formula and Mermaid diagram as source on the left, rendered on the right.',
    'clip.dragDrop':
      'A block dragged to a new place in a page, then a page dragged into a folder in the sidebar.',
    'clip.voice': 'A voice clip being recorded into a page, then played inline.',
    'clip.encryption':
      'Encrypting a vault from start to end: passphrase, recovery key, confirmation, then lock and unlock.',
    'clip.search': 'Searching the vault, narrowing by a tag, then opening a result at the match.',
    'clip.sampleVault':
      'The Moons of Kessari in the Global View: factions, places and people as cards.',
    'clip.play': 'Play the clip',
    'clip.pause': 'Pause the clip',
    'clip.enlarge': 'Enlarge the clip',
    'clip.close': 'Close',

    'what.kicker': 'What it is',
    'what.title': 'A notebook that stays yours',
    'what.p1.title': 'Plain Markdown, your folders',
    'what.p1.body':
      'Every note is a .md file you can open anywhere. Wikilinks, frontmatter and folders, exactly as you left them.',
    'what.p2.title': 'See it as a map',
    'what.p2.body':
      'The Global View shows projects, folders and pages as cards with covers, linked by what they reference. Drill in, or expand in place.',
    'what.p3.title': 'Sealed when you want',
    'what.p3.body':
      'Encrypt a vault with a passphrase, and keep a recovery key in case you forget it.',

    'bring.kicker': 'Bring your notes',
    'bring.title': 'Leave the cloud, keep your notes',
    'bring.lead':
      'Moving to something private shouldn’t mean starting over. Point Liber Linteum at the notes you already have, and they stay where they are: on your disk.',
    'bring.obsidian.title': 'Open your vault as it is',
    'bring.obsidian.body':
      'Choose the folder and you’re in. Nothing is converted, copied or moved; Obsidian and Liber Linteum can share the same vault.',
    'bring.obsidian.li1': '[[Wikilinks]], embeds, callouts, tags and frontmatter',
    'bring.obsidian.li2': 'Your attachment folder settings are respected',
    'bring.obsidian.li3': 'Its settings folder is left untouched',
    'bring.notion.title': 'Import your workspace',
    'bring.notion.body':
      'Export from Notion as Markdown & CSV, then give Liber Linteum the zip. It’s read on your machine; nothing is uploaded anywhere.',
    'bring.notion.li1': 'Pages and nested pages keep their structure and links',
    'bring.notion.li2': 'Databases become a page with a table, plus one note per row',
    'bring.notion.li3': 'Callouts and toggles become their Markdown equivalents',
    'bring.strip': 'Your notes move from a service you rent to a folder you own.',
    'bring.stripLink': 'Try it with the sample Notion export in the sample vault.',

    'features.kicker': 'Features',
    'features.title': 'A tour',
    'features.lead':
      'Recorded from the app itself, on the sample vault. Click any clip to watch it large.',
    'features.gv.kicker': 'Global View',
    'features.gv.title': 'Your notes as a canvas of cards',
    'features.gv.body':
      'Covers, titles and excerpts on every card; lines for links, folders and the relationships you draw by dragging from card to card.',
    'features.gv.li1': 'Drill into a folder, or expand it in place',
    'features.gv.li2': 'The positions you set are remembered',
    'features.atoms.kicker': 'Atoms',
    'features.atoms.title': 'Every page, broken into its parts',
    'features.atoms.body':
      'Right-click a card and choose See atoms: the page’s sections and blocks laid out as a tree of paragraphs, lists, callouts, code, tables, images, maths and diagrams. Click one to jump to it in the page.',
    'features.editor.kicker': 'Editor',
    'features.editor.title': 'Write in Live Preview',
    'features.editor.body':
      'Markdown that formats as you type, or the raw source, or both side by side.',
    'features.editor.li1': 'Code with highlighting, Mermaid diagrams, LaTeX maths',
    'features.editor.li2': 'Callouts, toggles, columns, highlights, coloured text',
    'features.editor.li3': 'Covers, icons and subtitles for every page',
    'features.maths.kicker': 'Maths & diagrams',
    'features.maths.title': 'LaTeX and Mermaid, side by side',
    'features.maths.body':
      'Write TeX between $…$ or $$…$$, and Mermaid in a code block. Split view shows the source and the rendered page together, updating as you type.',
    'features.maths.li1': 'KaTeX for maths, offline',
    'features.maths.li2': 'Mermaid flowcharts, sequences, timelines…',
    'features.dnd.kicker': 'Drag and drop',
    'features.dnd.title': 'Move things where they belong',
    'features.dnd.body':
      'Drag a block by its handle to reorder a page, drag pages and folders around the sidebar, and drag from card to card in the Global View to draw a relationship.',
    'features.voice.kicker': 'Voice clips',
    'features.voice.title': 'Record straight into a note',
    'features.voice.body':
      'Record from the microphone into the page you’re on. The clip is saved as an audio file in your vault and plays inline.',
    'features.enc.kicker': 'Encryption',
    'features.enc.title': 'Vaults sealed with a passphrase',
    'features.enc.body':
      'Choose Encrypt and, if you like, keep a readable copy in a folder you pick. Then choose a passphrase, save the recovery key and confirm two of its groups. From then on the vault locks when idle, on sleep and on quit, and unlocks with your passphrase.',
    'features.search.kicker': 'Search',
    'features.search.title': 'Find anything, instantly',
    'features.search.body':
      'Full-text search with filters by folder, tag, links and attachments, on your machine, over thousands of notes. Click a result to open the page at the match.',
    'features.mini.quick.title': 'Quick notes',
    'features.mini.quick.body': 'Ctrl+Shift+N from anywhere; a scratchpad in every vault.',
    'features.mini.find.title': 'Find in the page',
    'features.mini.find.body': 'Ctrl+F finds and replaces in the page; Ctrl+G jumps to a line.',
    'features.mini.colours.title': 'Your colours',
    'features.mini.colours.body': 'Palettes, light and dark, or a theme of your own.',
    'features.mini.trash.title': 'Trash & Archive',
    'features.mini.trash.body': 'Nothing is lost by a slip; archive what’s done.',
    'features.mini.spell.title': 'Spell check',
    'features.mini.spell.body': 'English and Spanish dictionaries, offline.',
    'features.mini.single.title': 'Single files',
    'features.mini.single.body': 'Open any .md or .txt file in a window of its own.',
    'features.mini.lang.title': 'English · Español',
    'features.mini.lang.body': 'The whole app, in both languages.',

    'privacy.lead':
      'No cloud, no accounts, no telemetry, and they aren’t settings. The app is built so it can’t: network access is blocked by its security policy, refused by its permissions, banned in its code and kept out of its dependencies.',
    'privacy.cloud.title': 'No cloud',
    'privacy.cloud.body':
      'Your notes live in a folder on your disk. Sync them with whatever you already trust, or don’t.',
    'privacy.accounts.title': 'No accounts',
    'privacy.accounts.body':
      'Nothing to sign up for, nothing to log into, nothing to lose access to.',
    'privacy.telemetry.title': 'No telemetry',
    'privacy.telemetry.body':
      'No analytics, no crash reports, no “anonymous usage data”. Zero requests, checked by tests.',

    'download.kicker': 'Download',
    'download.title': 'Get Liber Linteum',
    'download.pending.title': 'First release coming soon.',
    'download.pending.body':
      'The installers will appear here with their checksums. Until then, the code is on GitHub.',
    'download.pending.link': 'See the repository',
    'download.linux.f1': '.deb (Ubuntu, Debian)',
    'download.linux.f2': '.AppImage (any distribution)',
    'download.linux.button': 'Download .deb',
    'download.windows.f1': '.exe installer',
    'download.windows.f2': '.msi package',
    'download.windows.button': 'Download .exe',
    'download.macos.f1': '.dmg (Apple silicon and Intel)',
    'download.macos.f2': 'macOS 12 or later',
    'download.macos.button': 'Download .dmg',
    'download.platPending': 'Arrives with the first release',
    'download.sha': 'SHA-256',
    'download.virustotal': 'VirusTotal report',
    'download.virustotalPending': 'VirusTotal scan pending',
    'download.version': 'Version {version}',
    'download.unsigned.title': 'The installers aren’t code-signed yet.',
    'download.unsigned.body':
      'Windows may show “Windows protected your PC”: choose More info, then Run anyway. On macOS, right-click the app and choose Open the first time. Every file has a checksum and a VirusTotal scan above, so you can check it yourself.',
    'size.mb': '{n} MB',
    'size.kb': '{n} KB',

    'vault.kicker': 'Sample vault',
    'vault.title': 'The Moons of Kessari',
    'vault.lead':
      'A vault to explore before you bring your own: a short science-fiction story about a desert world, its factions, places and people, written for this app; plus a shelf of essays on the Dune films. Every feature is used somewhere in it.',
    'vault.chip.covers': 'covers & icons',
    'vault.chip.wikilinks': 'wikilinks',
    'vault.chip.relationships': 'relationships',
    'vault.chip.code': 'code',
    'vault.chip.callouts': 'callouts',
    'vault.chip.voice': 'a voice clip',
    'vault.chip.notion': 'a Notion export to import',
    'vault.button': 'Download the sample vault (.zip)',
    'vault.hint': 'Unzip it, then choose Open folder as vault.',
    'vault.notion': 'Also: the sample Notion export (.zip)',

    'roadmap.kicker': 'What’s next',
    'roadmap.title': 'Roadmap',
    'roadmap.lead':
      'What’s planned after the first release. No dates and no promises: just the direction.',
    'roadmap.planned': 'Planned',
    'roadmap.history.title': 'Version history',
    'roadmap.history.body':
      'Every page keeps its earlier versions: see what changed, and restore one. Still local: the history lives in your vault, not on a server.',
    'roadmap.slash.title': 'Slash menu',
    'roadmap.slash.body':
      'Type / at the start of a line to insert a heading, list, table, callout, code block, diagram or image without leaving the keyboard.',
    'roadmap.focus.title': 'Focus mode',
    'roadmap.focus.body':
      'Hide everything but the text: no sidebar, no toolbar, and the paragraph you’re on in focus.',
    'roadmap.transcribe.title': 'Offline transcription',
    'roadmap.transcribe.body':
      'Turn a voice clip into text with a speech model that runs on your machine: the audio never leaves it.',
    'roadmap.handwriting.title': 'Handwritten notes',
    'roadmap.handwriting.body':
      'Write by hand with a pen or a tablet and keep both: the handwriting stays in your vault, and its text becomes Markdown beside it, recognised offline.',
    'roadmap.ideas': 'Have an idea for what comes next?',
    'roadmap.ideasLink': 'Suggest it in the GitHub issues',

    'support.kicker': 'Support',
    'support.title': 'Free, and staying that way',
    'support.lead':
      'Liber Linteum is free software under the GPL. If it earns a place on your disk, you can help keep it growing.',
    'support.github': 'Sponsor on GitHub',
    'support.fallback':
      'Ways to donate are on their way. For now, a star on GitHub or telling a friend helps just as much.',
    credit: 'An idea by <b>José Meza</b>, built by <b>Jose Ríos</b>.',

    'footer.source': 'Source on GitHub',
    'footer.reactflow': 'Global View made with React Flow (MIT)',
  },

  es: {
    'meta.title': 'Liber Linteum: notas privadas que se quedan en tu equipo',
    'meta.description':
      'Una app de notas libre y de código abierto. Archivos Markdown en una carpeta que es tuya, un lienzo de tarjetas que muestra cómo se conectan, y sin nube, cuentas ni telemetría.',
    'meta.ogDescription':
      'Notas privadas que nunca salen de tu equipo: Markdown en una carpeta que es tuya. Sin nube, sin cuentas, sin telemetría.',
    skip: 'Saltar al contenido',
    'brand.label': 'Liber Linteum, volver al inicio',
    'nav.label': 'Secciones',
    'nav.bring': 'Trae tus notas',
    'nav.features': 'Funciones',
    'nav.privacy': 'Privacidad',
    'nav.sponsor': 'Patrocinar',
    'nav.download': 'Descargar',
    'nav.vault': 'Bóveda de ejemplo',
    'nav.roadmap': 'Hoja de ruta',
    'nav.support': 'Apoyar',
    'lang.label': 'Idioma',

    'hero.kicker': 'Notas privadas · libre y de código abierto',
    'hero.lead':
      'Tus notas son archivos Markdown en una carpeta que es tuya. Un lienzo de tarjetas muestra cómo se conectan. Nada sale de tu equipo.',
    'hero.downloadFor': 'Descargar para {os}',
    'hero.tryVault': 'Prueba la bóveda de ejemplo',
    'hero.compat': 'Abre bóvedas de Obsidian · Importa desde Notion',
    'hero.pledge':
      'Sin\u00a0nube · Sin\u00a0cuentas · Sin\u00a0telemetría · 0\u00a0conexiones\u00a0a\u00a0internet',

    'clip.hero':
      'La Vista global: una carpeta desplegada en el sitio, la entrada a otra, los átomos de una página y luego una edición rápida en Vista en vivo.',
    'clip.obsidian':
      'Se elige Abrir una bóveda de Obsidian y aparece la bóveda tal como la dejó Obsidian: avisos, incrustaciones, wikilinks y su configuración de adjuntos.',
    'clip.notion':
      'Una exportación de Notion importándose: páginas, subpáginas y una base de datos como tabla.',
    'clip.globalView':
      'Tarjetas de la Vista global que se expanden en el sitio para mostrar las páginas de una carpeta.',
    'clip.atoms':
      'Los átomos de una página en la Vista global: sus secciones y bloques como un árbol de tarjetas pequeñas.',
    'clip.editor':
      'Una página escrita en Vista en vivo, con un aviso y un bloque arrastrado a su lugar.',
    'clip.maths':
      'Modo Dividido: la fórmula en LaTeX y el diagrama Mermaid de una página como código fuente a la izquierda y renderizados a la derecha.',
    'clip.dragDrop':
      'Un bloque arrastrado a otro lugar de la página y luego una página arrastrada a una carpeta de la barra lateral.',
    'clip.voice': 'Una nota de voz grabándose en una página y luego reproduciéndose ahí mismo.',
    'clip.encryption':
      'Una bóveda cifrándose de principio a fin: frase de contraseña, clave de recuperación, confirmación, y luego bloqueo y desbloqueo.',
    'clip.search':
      'Una búsqueda en la bóveda, acotada por una etiqueta, y luego un resultado que se abre justo en la coincidencia.',
    'clip.sampleVault':
      'Las lunas de Kessari en la Vista global: facciones, lugares y personajes como tarjetas.',
    'clip.play': 'Reproducir el clip',
    'clip.pause': 'Pausar el clip',
    'clip.enlarge': 'Ampliar el clip',
    'clip.close': 'Cerrar',

    'what.kicker': 'Qué es',
    'what.title': 'Una libreta que sigue siendo tuya',
    'what.p1.title': 'Markdown, en tus carpetas',
    'what.p1.body':
      'Cada nota es un archivo .md que puedes abrir con cualquier programa. Wikilinks, frontmatter y carpetas, tal como los dejaste.',
    'what.p2.title': 'Míralo como un mapa',
    'what.p2.body':
      'La Vista global muestra proyectos, carpetas y páginas como tarjetas con portada, unidas por lo que enlazan. Entra en ellas o despliégalas en el sitio.',
    'what.p3.title': 'Sellada cuando quieras',
    'what.p3.body':
      'Cifra una bóveda con una frase de contraseña y guarda una clave de recuperación por si la olvidas.',

    'bring.kicker': 'Trae tus notas',
    'bring.title': 'Deja la nube, quédate con tus notas',
    'bring.lead':
      'Pasarte a algo privado no debería significar empezar de cero. Abre en Liber Linteum las notas que ya tienes y se quedan donde están: en tu disco.',
    'bring.obsidian.title': 'Abre tu bóveda tal como está',
    'bring.obsidian.body':
      'Eliges la carpeta y listo. No se convierte, copia ni mueve nada; Obsidian y Liber Linteum pueden compartir la misma bóveda.',
    'bring.obsidian.li1': '[[Wikilinks]], incrustaciones, avisos, etiquetas y frontmatter',
    'bring.obsidian.li2': 'Se respeta tu configuración de la carpeta de adjuntos',
    'bring.obsidian.li3': 'Su carpeta de ajustes queda intacta',
    'bring.notion.title': 'Importa tu espacio de trabajo',
    'bring.notion.body':
      'Exporta desde Notion como Markdown y CSV, y dale el zip a Liber Linteum. Se lee en tu equipo; no se sube nada a ninguna parte.',
    'bring.notion.li1': 'Las páginas y subpáginas conservan su estructura y sus enlaces',
    'bring.notion.li2':
      'Las bases de datos se vuelven una página con una tabla y una nota por fila',
    'bring.notion.li3': 'Los avisos y desplegables pasan a su equivalente en Markdown',
    'bring.strip': 'Tus notas pasan de un servicio que alquilas a una carpeta que es tuya.',
    'bring.stripLink': 'Pruébalo con la exportación de Notion que trae la bóveda de ejemplo.',

    'features.kicker': 'Funciones',
    'features.title': 'Un recorrido',
    'features.lead':
      'Grabado en la propia app, con la bóveda de ejemplo. Haz clic en cualquier clip para verlo en grande.',
    'features.gv.kicker': 'Vista global',
    'features.gv.title': 'Tus notas como un lienzo de tarjetas',
    'features.gv.body':
      'Portada, título y extracto en cada tarjeta; líneas para los enlaces, las carpetas y las relaciones que dibujas arrastrando de una tarjeta a otra.',
    'features.gv.li1': 'Entra en una carpeta o despliégala en el sitio',
    'features.gv.li2': 'Las posiciones que eliges se recuerdan',
    'features.atoms.kicker': 'Átomos',
    'features.atoms.title': 'Cada página, desarmada en sus partes',
    'features.atoms.body':
      'Haz clic derecho en una tarjeta y elige Ver átomos: las secciones y los bloques de la página se despliegan como un árbol de párrafos, listas, avisos, código, tablas, imágenes, fórmulas y diagramas. Haz clic en uno para ir a él en la página.',
    'features.editor.kicker': 'Editor',
    'features.editor.title': 'Escribe en Vista en vivo',
    'features.editor.body':
      'Markdown que toma formato mientras escribes, o el código fuente, o los dos lado a lado.',
    'features.editor.li1': 'Código con resaltado, diagramas Mermaid, fórmulas en LaTeX',
    'features.editor.li2': 'Avisos, desplegables, columnas, resaltados, texto en color',
    'features.editor.li3': 'Portada, icono y subtítulo para cada página',
    'features.maths.kicker': 'Fórmulas y diagramas',
    'features.maths.title': 'LaTeX y Mermaid, lado a lado',
    'features.maths.body':
      'Escribe TeX entre $…$ o $$…$$, y Mermaid en un bloque de código. El modo Dividido muestra juntos el código fuente y la página renderizada, y se actualiza mientras escribes.',
    'features.maths.li1': 'KaTeX para las fórmulas, sin conexión',
    'features.maths.li2': 'Mermaid: diagramas de flujo, de secuencia, líneas de tiempo…',
    'features.dnd.kicker': 'Arrastrar y soltar',
    'features.dnd.title': 'Mueve cada cosa a su lugar',
    'features.dnd.body':
      'Arrastra un bloque por su asa para reordenar una página, mueve páginas y carpetas por la barra lateral, y arrastra de una tarjeta a otra en la Vista global para trazar una relación.',
    'features.voice.kicker': 'Notas de voz',
    'features.voice.title': 'Graba directamente en una nota',
    'features.voice.body':
      'Graba con el micrófono en la página en la que estás. El clip se guarda como un archivo de audio en tu bóveda y se reproduce ahí mismo.',
    'features.enc.kicker': 'Cifrado',
    'features.enc.title': 'Bóvedas selladas con una frase de contraseña',
    'features.enc.body':
      'Elige Cifrar y, si quieres, guarda una copia legible en una carpeta que elijas. Luego elige una frase de contraseña, guarda la clave de recuperación y confirma dos de sus grupos. Desde ese momento la bóveda se bloquea por inactividad, al suspender el equipo y al salir, y se desbloquea con tu frase de contraseña.',
    'features.search.kicker': 'Búsqueda',
    'features.search.title': 'Encuentra cualquier cosa, al instante',
    'features.search.body':
      'Búsqueda de texto completo con filtros por carpeta, etiqueta, enlaces y adjuntos, en tu equipo, entre miles de notas. Haz clic en un resultado para abrir la página justo en la coincidencia.',
    'features.mini.quick.title': 'Notas rápidas',
    'features.mini.quick.body':
      'Ctrl+Shift+N desde cualquier parte; una carpeta de notas rápidas en cada bóveda.',
    'features.mini.find.title': 'Buscar en la página',
    'features.mini.find.body': 'Ctrl+F busca y reemplaza en la página; Ctrl+G salta a una línea.',
    'features.mini.colours.title': 'Tus colores',
    'features.mini.colours.body': 'Paletas, modo claro y oscuro, o un tema propio.',
    'features.mini.trash.title': 'Papelera y Archivo',
    'features.mini.trash.body': 'Nada se pierde por un descuido; archiva lo que ya terminaste.',
    'features.mini.spell.title': 'Corrector ortográfico',
    'features.mini.spell.body': 'Diccionarios de inglés y español, sin conexión.',
    'features.mini.single.title': 'Archivos sueltos',
    'features.mini.single.body': 'Abre cualquier .md o .txt en su propia ventana.',
    'features.mini.lang.title': 'English · Español',
    'features.mini.lang.body': 'Toda la app, en los dos idiomas.',

    'privacy.lead':
      'Sin nube, sin cuentas, sin telemetría, y no son ajustes. La app está hecha para que no pueda: su política de seguridad bloquea la red, sus permisos la niegan, su código la prohíbe y sus dependencias no la incluyen.',
    'privacy.cloud.title': 'Sin nube',
    'privacy.cloud.body':
      'Tus notas viven en una carpeta de tu disco. Sincronízalas con lo que ya uses y te dé confianza, o no las sincronices.',
    'privacy.accounts.title': 'Sin cuentas',
    'privacy.accounts.body':
      'Nada en lo que registrarte, nada en lo que iniciar sesión, nada a lo que perder el acceso.',
    'privacy.telemetry.title': 'Sin telemetría',
    'privacy.telemetry.body':
      'Sin analítica, sin informes de fallos, sin “datos de uso anónimos”. Cero conexiones, comprobado con pruebas.',

    'download.kicker': 'Descargar',
    'download.title': 'Descarga Liber Linteum',
    'download.pending.title': 'La primera versión llega pronto.',
    'download.pending.body':
      'Los instaladores aparecerán aquí con sus sumas de verificación. Mientras tanto, el código está en GitHub.',
    'download.pending.link': 'Ver el repositorio',
    'download.linux.f1': '.deb (Ubuntu, Debian)',
    'download.linux.f2': '.AppImage (cualquier distribución)',
    'download.linux.button': 'Descargar .deb',
    'download.windows.f1': 'Instalador .exe',
    'download.windows.f2': 'Paquete .msi',
    'download.windows.button': 'Descargar .exe',
    'download.macos.f1': '.dmg (Apple silicon e Intel)',
    'download.macos.f2': 'macOS 12 o posterior',
    'download.macos.button': 'Descargar .dmg',
    'download.platPending': 'Llega con la primera versión',
    'download.sha': 'SHA-256',
    'download.virustotal': 'Informe de VirusTotal',
    'download.virustotalPending': 'Análisis de VirusTotal pendiente',
    'download.version': 'Versión {version}',
    'download.unsigned.title': 'Los instaladores aún no están firmados.',
    'download.unsigned.body':
      'Windows puede mostrar “Windows protegió su PC”: elige Más información y luego Ejecutar de todas formas. En macOS, la primera vez haz clic derecho en la app y elige Abrir. Cada archivo tiene arriba su suma de verificación y un análisis de VirusTotal, para que lo compruebes tú mismo.',
    'size.mb': '{n} MB',
    'size.kb': '{n} KB',

    'vault.kicker': 'Bóveda de ejemplo',
    'vault.title': 'Las lunas de Kessari',
    'vault.lead':
      'Una bóveda para explorar antes de traer la tuya: un relato corto de ciencia ficción sobre un mundo desértico, sus facciones, lugares y personajes, escrito para esta app; y además una estantería de ensayos sobre las películas de Dune. Cada función se usa en algún lugar.',
    'vault.chip.covers': 'portadas e iconos',
    'vault.chip.wikilinks': 'wikilinks',
    'vault.chip.relationships': 'relaciones',
    'vault.chip.code': 'código',
    'vault.chip.callouts': 'avisos',
    'vault.chip.voice': 'una nota de voz',
    'vault.chip.notion': 'una exportación de Notion para importar',
    'vault.button': 'Descargar la bóveda de ejemplo (.zip)',
    'vault.hint': 'Descomprímela y elige Abrir carpeta como bóveda.',
    'vault.notion': 'Además: la exportación de Notion de ejemplo (.zip)',

    'roadmap.kicker': 'Lo que viene',
    'roadmap.title': 'Hoja de ruta',
    'roadmap.lead':
      'Lo que está planeado después de la primera versión. Sin fechas ni promesas: solo el rumbo.',
    'roadmap.planned': 'Planeado',
    'roadmap.history.title': 'Historial de versiones',
    'roadmap.history.body':
      'Cada página guarda sus versiones anteriores: mira qué cambió y restaura la que quieras. Todo sigue siendo local: el historial vive en tu bóveda, no en un servidor.',
    'roadmap.slash.title': 'Menú de barra (/)',
    'roadmap.slash.body':
      'Escribe / al inicio de una línea para insertar un título, una lista, una tabla, un aviso, un bloque de código, un diagrama o una imagen sin soltar el teclado.',
    'roadmap.focus.title': 'Modo concentración',
    'roadmap.focus.body':
      'Oculta todo menos el texto: sin barra lateral, sin barra de herramientas, y el párrafo en el que estás en primer plano.',
    'roadmap.transcribe.title': 'Transcripción sin conexión',
    'roadmap.transcribe.body':
      'Convierte un clip de voz en texto con un modelo de voz que corre en tu equipo: el audio nunca sale de él.',
    'roadmap.handwriting.title': 'Notas a mano',
    'roadmap.handwriting.body':
      'Escribe a mano con un lápiz o una tableta y conserva ambas cosas: el trazo se queda en tu bóveda y su texto se vuelve Markdown a su lado, reconocido sin conexión.',
    'roadmap.ideas': '¿Tienes una idea para lo que sigue?',
    'roadmap.ideasLink': 'Cuéntala en los issues de GitHub',

    'support.kicker': 'Apoyar',
    'support.title': 'Gratis, y así seguirá',
    'support.lead':
      'Liber Linteum es software libre bajo la GPL. Si se gana un lugar en tu disco, puedes ayudar a que siga creciendo.',
    'support.github': 'Patrocinar en GitHub',
    'support.fallback':
      'Pronto habrá formas de donar. Por ahora, una estrella en GitHub o recomendarla a alguien ayuda igual.',
    credit: 'Una idea de <b>José Meza</b>, construida por <b>Jose Ríos</b>.',

    'footer.source': 'Código fuente en GitHub',
    'footer.reactflow': 'Vista global hecha con React Flow (MIT)',
  },
};
