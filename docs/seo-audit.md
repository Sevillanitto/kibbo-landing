# Auditoría SEO · getkibbo.com

**Fecha:** 28 de septiembre de 2026 · **Alcance:** solo análisis del repo `kibbo-landing` + comprobaciones de solo lectura del sitio en vivo, de la API pública de Dev.to y de la API pública de GitHub. No se ha modificado ningún archivo del sitio.

---

## 0. Antes de nada: qué es hoy el sitio (y por qué importa para la estrategia)

El encargo describe getkibbo.com como un catálogo de dev tools. El repo dice otra cosa:

| Sección | Páginas HTML (tracked) |
|---|---|
| Blog (`/blog/`) | 525 |
| Checklists (`/checklists/`) | 155 |
| Plantillas (`/templates/`) | 145 |
| Preguntas (`/questions/`) | 100 |
| Generadores (`/generate/`) | 92 |
| Kits, directorio, pillars, calculadoras, Real Cases, investigaciones | ~90 |
| Raíz (incluye las **7 páginas de producto** de extensiones y `/developer-tools`) | 68 |
| **Total** | **1.175** (1.171 en `sitemap.xml`) |

Las extensiones (Cookie Consent Equalizer, Dark Patterns Detector, Price History Tracker, Checkout Security Shield, AI Legal & Contract Analyzer, Web Guardian Full Suite y AI Phishing Detector) son **7 páginas de 330–390 palabras**, que venden **código fuente** (9,90 $ / 19,90 $ en Gumroad), no extensiones instaladas desde la Chrome Web Store. El 99 % del inventario indexable es contenido de derechos del consumidor.

Consecuencia práctica: el mayor potencial de tráfico orgánico está en el contenido de consumo que ya existe. Las keywords de dev tools tienen un volumen probablemente pequeño. Este informe cubre las dos cosas: la auditoría técnica es de todo el sitio, y el plan de contenido y de backlinks se centra en los productos, como pide el encargo. Donde una recomendación depende de esa diferencia, lo indico.

### Método

- **Rastreo estático** de las 1.175 páginas: title, description, H1, canonical, robots, OG/Twitter, JSON-LD (parseado), imágenes, scripts del `<head>`, palabras de contenido (sin nav/footer), enlaces internos, enlaces rotos, huérfanas y cobertura del sitemap.
- **Comprobaciones en vivo con `curl`:** redirecciones de host, `.html` y barra final, y el mirror `*.vercel.app`.
- **Dev.to:** API pública (`/api/articles?username=carlos_lopez_e0907403c1b4`), con el canonical real de cada artículo publicado y la similitud de texto con el blog.
- **GitHub:** API pública (`/users/Sevillanitto/repos`) y README del repo Lite.

### Lo que NO se puede verificar desde el código (datos que necesito)

| Dato | Dónde sacarlo | Para qué |
|---|---|---|
| Clics, impresiones, CTR y posición por página y query (últimos 3–6 meses) | Search Console → Rendimiento → exportar páginas + consultas | Priorizar qué reescribir y detectar canibalización real entre versiones US/UK/EU/AU |
| Páginas indexadas vs. excluidas (sobre todo `/checklists/*` y `/generate/*`) | Search Console → Indexación → Páginas | Confirmar si las checklists renderizadas por JS se están indexando |
| Core Web Vitals de campo (LCP/INP/CLS) | Search Console → Core Web Vitals, o CrUX / PageSpeed Insights | El análisis de rendimiento de este informe es estático, no de campo |
| Backlinks actuales y dominios de referencia | Search Console → Enlaces; Ahrefs/Semrush | Línea base de la estrategia de backlinks |
| Volumen y dificultad de las keywords propuestas | Ahrefs / Semrush / Google Keyword Planner | Todas las keywords de la Parte 2 son **hipótesis sin volumen verificado** |
| Tráfico que llega desde Dev.to y GitHub | GA4 → Adquisición → referencias | Medir si los puentes funcionan |

### Lo que ya está bien (no tocar)

- **Metadatos:** 0 titles duplicados y 0 descriptions duplicadas en 1.171 páginas indexables. Solo 1 página sin description (`/analyzer/supplement-auditor`, que además da 404 en vivo).
- **Canonicals:** en 1.173 de 1.175 páginas, todos absolutos, con www y sin `.html`, y ninguno apunta a otra URL.
- **Redirecciones:** `.html` → URL limpia y barra final → sin barra, con **308**. `http://www` → `https://www` con 308.
- **Sitemap:** `sitemap.xml` coincide con las páginas reales (no hay URLs del sitemap sin página). `robots.txt` es correcto y apunta al sitemap.
- **JSON-LD:** 0 bloques con errores de parseo. Tipos por sección: `BlogPosting` + `BreadcrumbList` en los 525 posts, `FAQPage` en las 100 preguntas, `Product`+`Offer` en las 145 plantillas, `WebApplication` en los generadores, `CollectionPage` en los kits y `Article` en investigaciones y Real Cases.
- **Accesibilidad y medios:** 0 imágenes sin `alt`. `lang` en todas las páginas. OG/Twitter en casi todas.
- **JavaScript en el `<head>`:** todos los scripts llevan `defer`. Las fuentes se cargan con `preload` + `onload`, sin bloquear el render.
- **Otros:** `llms.txt` presente. Los embeds (`/embed/*`) tienen `noindex` correcto.

---

## 1. Resumen ejecutivo

1. **Dos artículos de Dev.to se tragan a sus originales del blog.** "I built a Chrome extension that catches every dark pattern…" (17 jun) y "I built a phishing detector into Chrome using Claude AI…" (19 jun) comparten el 94–95 % del texto con `/blog/dark-patterns-detector-javascript` y `/blog/phishing-detector-chrome-claude-ai` (20 jun). Se publicaron antes y su canonical apunta a Dev.to. Para Google, el original es Dev.to. **Arreglo:** cambiar el canonical de esos dos posts en Dev.to (5 minutos).
2. **El catálogo de extensiones está enterrado.**
   - Cada página de producto tiene **1 enlace interno entrante**, y viene de `/developer-tools`.
   - `/developer-tools` solo recibe un enlace, desde `/terms`, y no está en el menú.
   - Los 7 artículos técnicos mandan el CTA a Gumroad en vez de a la página del producto.

   **Arreglo:** enlazar las páginas de producto desde la nav o el footer, desde sus artículos y entre sí.
3. **Las 155 checklists se renderizan 100 % por JavaScript** (`window.CHECKLIST_CONFIG` + `checklist-engine.js`). El HTML servido tiene 21 palabras y ninguna H1. **Arreglo:** pre-renderizar el contenido en el HTML estático; ya existe el patrón del script generador de embeds.
4. **LCP pesado en las 100 preguntas.** Cada una carga como imagen hero un PNG de 1600×900 de ~1,9 MB con `loading="eager"`. Hay 226 PNG que suman 172 MB en el repo. **Arreglo:** WebP (≈10× menos) + `<picture>` + `fetchpriority="high"`.
5. **Titles y descriptions demasiado largos.** 630 titles pasan de 65 caracteres (la mediana del blog es 83) y 693 descriptions pasan de 165. Google los corta; el CTR se puede recuperar reescribiendo primero los que tienen más impresiones en Search Console.

---

## 2. Parte 1 · Auditoría técnica priorizada

Leyenda: **Impacto** sobre tráfico orgánico. **Esfuerzo** para una persona. Ordenado por impacto/esfuerzo.

### 2.1 Quick wins (menos de 1 hora cada uno)

| # | Hallazgo | Impacto | Esfuerzo | Archivo / ruta afectada | Solución concreta |
|---|---|---|---|---|---|
| Q1 | Dos posts de Dev.to (94–95 % idénticos al blog y publicados 1–3 días antes) tienen canonical a sí mismos. Google puede elegir Dev.to como original y relegar los del blog. | **Alto** | Bajo | Dev.to: `/carlos_lopez_e0907403c1b4/i-built-a-chrome-extension-that-catches-every-dark-pattern-trick-on-shopping-sites-heres-exactly-9ef` y `…/i-built-a-phishing-detector-into-chrome-using-claude-ai-heres-exactly-how-2d6c`. Blog: `/blog/dark-patterns-detector-javascript`, `/blog/phishing-detector-chrome-claude-ai` | En Dev.to → Edit → ⚙️ → *Canonical URL* = `https://www.getkibbo.com/blog/dark-patterns-detector-javascript` y `https://www.getkibbo.com/blog/phishing-detector-chrome-claude-ai`. Añadir en el primer párrafo de cada post un enlace "Originally published on Kibbo". El de dark patterns hoy tiene 0 enlaces a getkibbo. |
| Q2 | Los 7 artículos técnicos no enlazan a la página de su producto. Su CTA va directo a Gumroad (dominio externo). | **Alto** | Bajo | `blog/dark-patterns-detector-javascript.html`, `phishing-detector-chrome-claude-ai.html`, `checkout-intercept-formjacking-magecart.html`, `extension-bloat-browser-security-consolidation.html`, `cookie-consent-dark-patterns-privacy-laws.html`, `the-60-percent-trap-fake-discounts-dynamic-pricing.html`, `forced-arbitration-fine-print-contract-analyzer.html` | Cambiar el CTA (o añadir uno previo) para que apunte a `/dark-patterns-detector`, `/ai-phishing-detector`, `/checkout-security-shield`, `/web-guardian-suite`, `/cookie-consent-equalizer`, `/price-history-tracker` y `/legal-contract-analyzer`. Gumroad queda como paso 2, desde la página de producto. |
| Q3 | `/developer-tools` (hub del catálogo) solo recibe 1 enlace interno, desde `/terms`, y no está en la nav. El `CLAUDE.md` define "Dev Tools" en el orden de la nav, pero la nav actual no lo incluye. | **Alto** | Bajo* | `developer-tools.html`, nav duplicada en 1.158 páginas, footer | Añadir "Developer Tools" a la columna *Tools* del footer (y/o al dropdown *Tools* de la nav) con el script de reemplazo sitewide ya probado. \*Es un script, no edición manual. |
| Q4 | 525 enlaces del blog a `https://www.getkibbo.com/authors.html#…` (y 17 más con `.html`) generan una redirección 308 en cada clic y en cada rastreo. | Medio | Bajo | Todos los `blog/*.html` (byline); `questions/*` (10); calculadoras enlazadas con `.html` | Reemplazo sitewide de `authors.html#` por `/authors#` y quitar el `.html` de los otros 17 enlaces. |
| Q5 | 4 enlaces internos rotos. | Medio | Bajo | `blog/overbooked-flight-compensation-400-percent-rule.html` → `/blog/overbooked-flight-compensation-claim`. `legal-contracts/calculators/cooling-off-period-calculator.html` → `' + href + '` (bug de JS en una plantilla). `questions/privacy-data/can-employer-read-private-emails-work-computer.html` → `/questions/employment`. `questions/subscriptions-services/can-company-keep-charging-me-after-cancelled.html` → `/questions/subscriptions-services/can-subscription-continue-after-payment-card-expires` | Corregir cada enlace a una URL existente, o quitarlo. |
| Q6 | 2 case studies del blog son huérfanos: no aparecen en `blog.html` y nada enlaza a ellos. | Medio | Bajo | `/blog/case-gym-membership-auto-renewal-clause`, `/blog/case-parcel-delivered-wrong-address-uk` | Añadir sus tarjetas en `blog.html` (los otros dos case studies sí están). |
| Q7 | `/article-template` (plantilla con title "Article Title — Kibbo Guides") está en línea (200) e indexable, sin nav ni canonical. | Medio | Bajo | `article-template.html` | Añadir `<meta name="robots" content="noindex">`, o sacarla del despliegue (p. ej. `.vercelignore`). |
| Q8 | El dominio sin www redirige con **307 temporal** (`https://getkibbo.com/` → `https://www.getkibbo.com/`). | Medio | Bajo | Configuración de dominios en Vercel | En Vercel → Domains, marcar `getkibbo.com` como *Redirect to www.getkibbo.com* con **308 Permanent**. |
| Q9 | Mirror completo en `https://kibbo-landing.vercel.app` (200 en todas las URLs). Los canonicals absolutos a www mitigan el daño, pero hay rastreo duplicado. | Bajo | Bajo | `vercel.json` / dominios de Vercel | Redirigir el host `*.vercel.app` a www (redirect con `has: host`), o `X-Robots-Tag: noindex` para ese host. |
| Q10 | El title del tutorial técnico lleva una etiqueta de país errónea: "Build a Phishing Detector with Claude AI **(UK)**". Viene de la pasada de etiquetas de país. | Bajo | Bajo | `blog/phishing-detector-chrome-claude-ai.html` (title, og:title, twitter:title) | Quitar "(UK)" y revisar que ningún otro artículo técnico la tenga. |
| Q11 | `llms.txt` no menciona Real Cases, Kits, Datasets ni las extensiones. | Bajo | Bajo | `llms.txt` | Añadir esas secciones con una línea cada una. |
| Q12 | 37 páginas cargan gtag.js inline antes del consentimiento (35 preguntas + 2 investigaciones). Es más JS de terceros en el render y un riesgo de cumplimiento. | Bajo (SEO) | Bajo | `questions/*/*.html` (35), `investigations/ai-scam-playbook-2026.html`, `investigations/streaming-price-machine.html` | Quitar el bloque inline: `cookie-consent.js` ya carga GA tras aceptar. |

### 2.2 Resto (más de 1 hora)

| # | Hallazgo | Impacto | Esfuerzo | Archivo / ruta afectada | Solución concreta |
|---|---|---|---|---|---|
| R1 | Las **155 checklists** se construyen entera y únicamente en el navegador desde `window.CHECKLIST_CONFIG`. El HTML servido tiene 21 palabras, **ninguna H1** y ningún ítem. Google renderiza JS (con retraso). Los crawlers de IA (GPTBot, ClaudeBot, PerplexityBot) y muchas herramientas SEO ven páginas vacías. Tampoco tienen `twitter:card`. | **Alto** | Medio | `checklists/*.html` (155), `checklists/checklist-engine.js` | Script de build (mismo patrón que `scripts/build-embeds.py`) que escriba en el HTML estático la H1, la intro y cada zona como `<h2>` con su `<ul>` de ítems. El motor JS solo añade la interactividad (checkboxes, progreso). Añadir `twitter:card`. Verificar primero en Search Console → Indexación cuántas están indexadas. |
| R2 | Imagen hero de las **100 preguntas**: PNG de 1600×900, **~1,9 MB**, con `loading="eager"`. Es casi seguro el LCP. En total, 226 PNG = **172 MB**. Solo existen WebP para las tarjetas verticales (100), no para los heros. Solo 19 páginas usan `<picture>`. | **Alto** | Medio | `images/questions/**/*-hero.png`, `questions/**/*.html`, `investigations-images/us-airline-ranking-2026-h1-hero.png` (2,3 MB) | Convertir los heros a WebP (objetivo: menos de 200 KB) con un script. Servir con `<picture><source type="image/webp">` + `fetchpriority="high"` y mantener el `width`/`height` que ya tienen. Validar el LCP antes y después con PageSpeed Insights. |
| R3 | **Catálogo de extensiones débil para posicionar.** Las 7 páginas de producto tienen 325–390 palabras, 0 imágenes o capturas y 0 FAQ. Sus H1 y titles son solo el nombre ("Dark Patterns Detector — Kibbo"), sin la intención de búsqueda. Hay 1 enlace interno entrante por página. | **Alto** | Medio | `cookie-consent-equalizer.html`, `dark-patterns-detector.html`, `price-history-tracker.html`, `checkout-security-shield.html`, `legal-contract-analyzer.html`, `web-guardian-suite.html`, `ai-phishing-detector.html`, `developer-tools.html` | Por página: title con intención ("Dark Patterns Detector — Chrome Extension Source Code (Manifest V3) · Kibbo"), 2–3 capturas o un GIF, una sección "cómo funciona por dentro" (arquitectura y fragmentos de código), FAQ visible (licencia, MV3, personalización), enlaces al artículo técnico y a las páginas hermanas. Convertir `/developer-tools` en el pillar del cluster (ver Parte 2). |
| R4 | Schema de producto incorrecto. Las extensiones usan `WebApplication` con `operatingSystem: "Web"` y `applicationCategory` variable (Utilities/Security/Business/Developer). Sin `BreadcrumbList`. | Medio | Bajo | Las 7 páginas de producto | `SoftwareApplication` con `operatingSystem: "Chrome"`, `applicationCategory: "BrowserApplication"`, `offers` (ya existe) y `BreadcrumbList` (Home → Developer Tools → Producto). No habrá rich result sin `aggregateRating`/`review`; no inventarlos. |
| R5 | **92 generadores** con una mediana de 158 palabras: el formulario lo construye JS y el texto estático es mínimo. Riesgo de contenido fino. | Medio | Medio | `generate/*.html` | Añadir contenido estático bajo el formulario: qué cubre la carta, cuándo usarla, qué ley cita por país, qué hacer si no responden, y un ejemplo de salida. Empezar por los 10 con más impresiones en Search Console. |
| R6 | **630 titles pasan de 65 caracteres** (blog: 470; mediana del blog 83, p90 98) y **693 descriptions pasan de 165**. Google los trunca. | Medio | Medio (por lotes) | Sobre todo `blog/*.html`, `questions/*`, `checklists/*`, `templates/*` | No reescribir en masa a ciegas. Exportar de Search Console las páginas con más impresiones y CTR bajo, y reescribir esas primero (objetivo: 50–60 caracteres de title y 140–155 de description), con la keyword al principio y el país solo si aporta. |
| R7 | Enlazado interno pobre en el blog: **542 páginas** tienen solo 1–2 enlaces entrantes (391 son del blog). El único enlace de la mayoría es el índice `blog.html`, que lista 525 posts en una sola página. | Medio | Medio | `blog/*.html`, pillars | El flujo `CROSSLINK_TAGS` ya existe para herramientas. Añadir un bloque "Artículos relacionados" (3–5 del mismo bloque y país) en cada post, generado por script desde `search-index.json`. Además, un enlace a cada post desde su pillar de bloque. |
| R8 | Hay 308 posts con prefijo de país (`us-` 57, `uk-` 77, `eu-` 104, `au-` 70) y **ningún hreflang**. No hay titles duplicados, pero es probable que haya solapamiento temático entre versiones por país. | Medio | Medio | `blog/us-*`, `uk-*`, `eu-*`, `au-*` | **Primero medir:** en Search Console, ver si dos versiones rankean para la misma query. Solo si son equivalentes de verdad (misma intención, distinto país), añadir `hreflang` en-US / en-GB / en-AU / en (EU) + `x-default` entre ellas. Si no son equivalentes, no usar hreflang: reforzar la diferencia (país en H1 y en title). |
| R9 | `/free-consumer-rights-templates` es huérfana (0 enlaces entrantes), no tiene la nav del sitio y su title ("13 Free Consumer Rights Templates — Restaurant & Food Complaints") se solapa con el roundup publicado el 26 de septiembre. | Bajo | Bajo | `free-consumer-rights-templates.html` | Redirigir con 301/308 a `/blog/free-consumer-templates-roundup` (o a `/templates#food-hospitality`) y quitarla del sitemap. |
| R10 | `/terms` ("Terms of Service") y `/terms-of-use` ("Terms of Use") son dos documentos legales distintos (2 % de texto en común), ambos en el sitemap. `/terms` no tiene nav ni OG. | Bajo | Bajo | `terms.html`, `terms-of-use.html` | Decidir cuál es el vigente y redirigir el otro. Es más un tema legal que SEO. |
| R11 | 9 páginas institucionales sin JSON-LD (`/about`, `/authors`, `/corrections-log`, `/cookie-policy`…). | Bajo | Bajo | `about.html`, `authors.html`, `corrections-log.html`, etc. | `AboutPage`/`ProfilePage` en `/about` y `/authors` (refuerza E-E-A-T). El resto no hace falta. |
| R12 | `FAQPage` en las 100 preguntas: desde agosto de 2023 Google solo muestra rich results de FAQ para sitios gubernamentales y de salud con autoridad. | Bajo | — | `questions/**` | Mantener (no perjudica y ayuda a buscadores de IA), pero no invertir más en FAQ schema esperando rich results. |
| R13 | 532 `<img>` sin atributo `width` (riesgo de CLS). | Bajo | Medio | Varias (priorizar las imágenes por encima del pliegue) | Añadir `width`/`height` al menos a las imágenes above the fold. Confirmar con los datos de CLS de campo antes de invertir. |
| R14 | `styles.css` (108 KB) es una única hoja que bloquea el render en todas las páginas. | Bajo | Alto | `styles.css` | No prioritario. Solo si los datos de campo muestran LCP/FCP malos tras R2. |
| R15 | El repo `Sevillanitto/kibbo-landing` (el código del sitio) es público, con homepage `kibbo-landing.vercel.app`. | Bajo (SEO) | Bajo | GitHub | Cambiar la homepage del repo a `https://www.getkibbo.com` (o hacerlo privado si no aporta). |

**Hreflang e idiomas:** todo el sitio está en inglés (`lang="en"`). No hay contenido en otro idioma dentro de este repo, así que no hace falta hreflang de idioma. Las versiones por país se tratan en R8.

---

## 3. Parte 2 · Plan de contenido long-tail

> Todas las keywords son **hipótesis de intención sin volumen ni dificultad verificados**. Validar con Ahrefs/Semrush o Keyword Planner antes de escribir, y descartar las de volumen 0. "Competencia probable" es una estimación cualitativa: nicho técnico + resultados dominados por foros o GitHub = baja.

### 3.1 Clusters, pillars y satélites

| Cluster | Página pilar (existente → mejorada) | Producto(s) | Satélites existentes |
|---|---|---|---|
| **A. Privacidad y cookies** | Nueva: `/blog/cookie-banner-reject-all-developer-guide` (o convertir `/blog/cookie-consent-dark-patterns-privacy-laws` en pillar) | Cookie Consent Equalizer | `cookie-consent-dark-patterns-privacy-laws` |
| **B. Dark patterns y precios** | `/blog/dark-patterns-detector-javascript` (ampliar a guía completa de detección) | Dark Patterns Detector, Price History Tracker | `the-60-percent-trap-fake-discounts-dynamic-pricing` |
| **C. Seguridad en el navegador y el checkout** | `/developer-tools` como hub + nuevo pillar "Browser-side payment security" | Checkout Security Shield, Web Guardian Full Suite, AI Phishing Detector | `checkout-intercept-formjacking-magecart`, `extension-bloat-browser-security-consolidation`, `phishing-detector-chrome-claude-ai` |
| **D. Análisis legal con IA** | `/legal-contract-analyzer` (producto) + `/legal-contract-auditor` (herramienta gratuita) | AI Legal & Contract Analyzer | `forced-arbitration-fine-print-contract-analyzer` |

Regla de enlazado para cada cluster: satélite → pillar → producto, y producto → pillar + 2 satélites. El CTA de cada artículo apunta primero a la página de producto (no a Gumroad).

### 3.2 Keywords long-tail por producto

Intención: **I** = informacional, **C** = comparativa, **T** = transaccional.

**Cookie Consent Equalizer** (cluster A)
| Keyword | Intención | Competencia probable |
|---|---|---|
| chrome extension auto reject cookies | T | Media |
| reject all cookies button missing gdpr | I | Baja |
| cookie banner dark patterns examples | I | Media |
| how to build a cookie banner auto-reject extension manifest v3 | I | Baja |
| consent-o-matic alternative | C | Baja |
| i don't care about cookies alternative that rejects | C | Baja |
| detect cookie wall javascript | I | Baja |
| equal prominence reject button cnil edpb | I | Baja |
| cookie consent extension source code | T | Baja |

**Dark Patterns Detector** (cluster B)
| Keyword | Intención | Competencia probable |
|---|---|---|
| detect dark patterns javascript | I | Baja |
| fake countdown timer detection extension | T | Baja |
| fake scarcity "only 2 left" how to tell | I | Media |
| dark pattern detection chrome extension | T | Baja |
| confirmshaming examples ecommerce | I | Media |
| dark patterns dataset princeton mathur | I | Baja |
| dom scanning manifest v3 content script tutorial | I | Media |
| dark patterns detector source code | T | Baja |

**Price History Tracker** (cluster B)
| Keyword | Intención | Competencia probable |
|---|---|---|
| build a price history chrome extension | I | Baja |
| keepa alternative for any store | C | Media |
| camelcamelcamel alternative non amazon | C | Baja |
| how to tell if a discount is fake | I | Media |
| honey alternative privacy | C | Media |
| price tracker extension no account | T | Baja |
| track price history locally indexeddb extension | I | Baja |
| was price reference pricing fake eu omnibus 30 day | I | Baja |

**Checkout Security Shield** (cluster C)
| Keyword | Intención | Competencia probable |
|---|---|---|
| how to detect formjacking in the browser | I | Baja |
| magecart skimmer detection extension | T | Baja |
| check if checkout page is compromised | I | Baja |
| detect injected script on payment page javascript | I | Baja |
| csp vs sri vs browser extension magecart | C | Baja |
| web skimming protection for shoppers | I | Baja |
| checkout security chrome extension source code | T | Baja |
| third-party script monitoring payment page pci dss 4.0 6.4.3 | I | Media |

**AI Legal & Contract Analyzer** (cluster D)
| Keyword | Intención | Competencia probable |
|---|---|---|
| ai contract analyzer chrome extension | T | Media |
| analyze terms of service with ai | I | Media |
| build contract clause analyzer claude api | I | Baja |
| detect forced arbitration clause ai | I | Baja |
| chatgpt vs dedicated contract review tool | C | Media |
| unfair contract terms checker | T | Media |
| llm prompt for contract risk review | I | Baja |
| summarize terms and conditions extension | T | Media |

**Web Guardian Full Suite** (cluster C)
| Keyword | Intención | Competencia probable |
|---|---|---|
| too many browser extensions security risk | I | Media |
| all in one privacy extension vs ublock origin privacy badger | C | Media |
| browser extension permissions risk | I | Media |
| consolidate chrome security extensions | I | Baja |
| manifest v3 privacy extension source code bundle | T | Baja |
| chrome extension supply chain attack examples | I | Media |
| minimal browser extension setup for privacy | I | Baja |
| web guardian extension review | C (navegacional) | Baja |

**AI Phishing Detector** (cluster C; puente GitHub Lite → versión completa)
| Keyword | Intención | Competencia probable |
|---|---|---|
| phishing detector claude api | I | Baja |
| llm phishing email classifier open source | I | Baja |
| cloudflare worker proxy api key tutorial | I | Media |
| scam sms checker extension | T | Media |
| ai phishing detection chrome extension source code | T | Baja |
| prompt for phishing classification | I | Baja |
| is this message a scam checker | T | Alta (dejar a la herramienta gratuita `/phishing-detector`) |

### 3.3 Calendario de 12 artículos (priorizado)

Orden pensado para: 1) reforzar primero lo que ya tiene un artículo satélite; 2) una comparativa temprana (intención alta y competencia baja); 3) una pieza enlazable por cluster.

| # | Semana | Título | Keyword objetivo | Intención | Esquema H2 / H3 | Enlaza a | CTA |
|---|---|---|---|---|---|---|---|
| 1 | 1 | How to Detect Dark Patterns with JavaScript: A Practical Guide (Manifest V3) | detect dark patterns javascript | I | H2 Qué es un dark pattern detectable en el DOM · H2 Los 12 tipos (H3 por tipo, con selector y heurística) · H2 Arquitectura del content script · H2 Falsos positivos · H2 Probarlo en sitios reales | `/dark-patterns-detector` (y pillar B) | "Get the full source (12 classifiers)" → página de producto |
| 2 | 1 | Consent-O-Matic vs "I Don't Care About Cookies" vs Building Your Own Auto-Reject | consent-o-matic alternative | C | H2 Qué hace cada una (H3 aceptar vs rechazar) · H2 Tabla comparativa · H2 Privacidad y permisos · H2 Cuándo construir la tuya · H2 Veredicto | `/cookie-consent-equalizer` | Página de producto |
| 3 | 2 | How to Detect Formjacking (Magecart) From the Browser | how to detect formjacking in the browser | I | H2 Cómo funciona un skimmer · H2 Señales observables (H3 scripts inyectados, H3 exfiltración a dominios nuevos, H3 mutaciones del form) · H2 Qué puede y no puede ver una extensión · H2 Checklist para compradores | `/checkout-security-shield` + `/blog/checkout-intercept-formjacking-magecart` | Página de producto |
| 4 | 2 | Keepa and CamelCamelCamel Only Cover Amazon — How to Track Price History on Any Store | camelcamelcamel alternative non amazon | C | H2 Límites de Keepa/CCC · H2 Opciones para otras tiendas · H2 Construir un tracker local (H3 IndexedDB, H3 selectores de precio) · H2 Detectar descuentos falsos (regla UE de 30 días) | `/price-history-tracker` + `the-60-percent-trap…` | Página de producto |
| 5 | 3 | Building an LLM Phishing Classifier Without Leaking Your API Key (Cloudflare Worker Pattern) | phishing detector claude api | I | H2 Por qué no llamar a la API desde el front · H2 El Worker proxy (H3 secretos, H3 CORS, H3 rate limit) · H2 El prompt y el parseo · H2 Versión Lite vs completa | `/ai-phishing-detector` + repo GitHub Lite | "Start with the free Lite repo" + página de producto |
| 6 | 3 | Too Many Browser Extensions? The Security Case for Fewer, Auditable Ones | too many browser extensions security risk | I | H2 Permisos y superficie de ataque · H2 Casos reales de extensiones compradas o comprometidas · H2 Cómo auditar las tuyas · H2 Consolidar sin perder cobertura | `/web-guardian-suite` + `extension-bloat…` | Página de producto |
| 7 | 4 | Cookie Banners That Break the Rules: 20 Dark Patterns, With the Code That Detects Them | cookie banner dark patterns examples | I | H2 Qué exige "equal prominence" (EDPB/CNIL) · H2 20 patrones (H3 cada uno + captura + regla de detección) · H2 Cómo reportar | `/cookie-consent-equalizer` (pillar A) | Página de producto |
| 8 | 4 | Build a Contract Clause Analyzer with the Claude API | build contract clause analyzer claude api | I | H2 Qué cláusulas detectar (H3 arbitraje, H3 renovación automática, H3 cesión de datos) · H2 Prompt y esquema de salida · H2 Evaluación con contratos reales · H2 Límites legales | `/legal-contract-analyzer` + `/legal-contract-auditor` (gratis) | "Try the free auditor" → producto |
| 9 | 5 | Honey Alternatives That Don't Track You | honey alternative privacy | C | H2 Qué pasó con Honey (atribución de afiliados) · H2 Qué buscar en una alternativa · H2 Tabla comparativa · H2 Opción autoalojada | `/price-history-tracker` | Página de producto |
| 10 | 6 | CSP vs SRI vs Browser Extensions: What Actually Stops Web Skimming? | csp vs sri vs browser extension magecart | C | H2 Qué protege cada capa (H3 CSP, H3 SRI, H3 extensión) · H2 PCI DSS 4.0 req. 6.4.3 · H2 Qué hace el comprador vs el comercio | `/checkout-security-shield` | Página de producto |
| 11 | 7 | The Dark Patterns Field Guide: 12 Tricks, Real Screenshots, and How to Spot Them | fake countdown timer detection | I (enlazable) | H2 por patrón + captura + "cómo lo detecta el código" · H2 Descargable (checklist) | Pillar B, `/dark-patterns-detector`, checklist existente | Página de producto + checklist |
| 12 | 8 | ChatGPT vs a Dedicated Contract Analyzer: We Tested Both on 10 Real Terms of Service | chatgpt vs dedicated contract review tool | C (datos propios) | H2 Metodología · H2 Resultados (H3 por contrato) · H2 Dónde falla cada uno · H2 Dataset descargable | `/legal-contract-analyzer`, `/datasets` | Página de producto + dataset |

Cada artículo: title de 50–60 caracteres, canonical propio, cross-post a Dev.to **solo después** de publicar en el blog y con `canonical_url` al blog (ver Parte 3).

### 3.4 Contenido existente: reescribir, fusionar, eliminar

| Acción | URL | Motivo |
|---|---|---|
| **Reescribir y ampliar** | `/blog/phishing-detector-chrome-claude-ai` (477 palabras) | Fino para un tutorial. Quitar "(UK)" del title, ampliar con el patrón del Worker y enlazar al repo Lite y al producto. |
| **Reescribir y ampliar** | `/blog/dark-patterns-detector-javascript` | Convertirlo en el pillar del cluster B (artículo #1 del calendario, misma URL). |
| **Reescribir** | Las 7 páginas de producto | Ver R3 y R4. |
| **Reescribir** | `/developer-tools` (329 palabras, H1 "Source code you own") | Convertirlo en hub: qué es cada herramienta, a quién va dirigida, comparativa, enlaces a los pillars. H1 con intención ("Privacy & Security Chrome Extensions — Full Source Code"). |
| **Diferenciar** | `/phishing-detector` (herramienta web gratuita) vs `/ai-phishing-detector` (código de la extensión); `/legal-contract-auditor` vs `/legal-contract-analyzer` | Titles parecidos para intenciones distintas. Hacer explícito en title y H1 cuál es "check a message/contract online (free)" y cuál es "extension source code", y enlazarlas entre sí. |
| **Fusionar / redirigir** | `/free-consumer-rights-templates` → `/blog/free-consumer-templates-roundup` | Huérfana, sin nav, solapada. |
| **Noindex / eliminar del deploy** | `/article-template` | Plantilla interna indexable. |
| **Eliminar del repo** | `analyzer/supplement-auditor/index.html` | Da 404 en vivo. Sin canonical, sin description y fuera del sitemap. |
| **Decidir** | `/terms` vs `/terms-of-use` | Dos documentos legales en vigor. |
| **Mantener** | Los otros 5 artículos técnicos | Buena longitud (1.100–1.540 palabras). Solo necesitan el enlace al producto (Q2) y más enlaces entrantes. |

### 3.5 Páginas de comparativa y de caso de uso

**Comparativas (nuevas; intención C, alta conversión).** Los nombres de competidores son candidatos a validar; comprobar que siguen activos antes de escribir:
- `/compare/cookie-consent-extensions`: Cookie Consent Equalizer vs Consent-O-Matic vs I Don't Care About Cookies vs uBlock Origin (listas *annoyances*).
- `/compare/price-trackers`: vs Keepa, CamelCamelCamel y Honey (con el ángulo de privacidad).
- `/compare/phishing-protection-extensions`: vs Netcraft Extension y Guardio.
- `/compare/privacy-extension-bundles`: Web Guardian Full Suite vs uBlock Origin + Privacy Badger + Consent-O-Matic por separado.
- `/compare/contract-review-ai`: vs ChatGPT/Claude con prompt manual.

**Casos de uso (uno o dos por producto):**
- Cookie Consent Equalizer: "Audit a site's cookie banner for GDPR equal-prominence compliance" (para devs y agencias).
- Dark Patterns Detector: "Run a dark-pattern audit on your own checkout before launch" (para devs de ecommerce).
- Price History Tracker: "Verify Black Friday 'was' prices across any store".
- Checkout Security Shield: "What a freelance dev can check on a client's WooCommerce/Shopify checkout".
- AI Legal & Contract Analyzer: "Review a SaaS vendor's ToS before signing" y "Freelancer contract red flags" (se apoya en las plantillas de freelancers existentes).
- Web Guardian Full Suite: "A minimal, auditable extension setup for a small team".
- AI Phishing Detector: "Self-host a scam-SMS checker for your family or support team" (puente al repo Lite).

---

## 4. Parte 3 · Estrategia de backlinks (fundador en solitario)

Activos enlazables que **ya existen** en el repo:
- **Investigaciones con datasets descargables:** 4 investigaciones + `/datasets`.
- **Calculadoras embebibles con atribución:** 3 en `/embed/*`, con un snippet que ya incluye el enlace.
- **Real Cases con fuentes primarias:** 7.
- **Contenido gratuito:** 145 plantillas y 155 checklists.
- **Directorios de lanzamiento:** ya en Nick Launches y Startup Inspire (badges en el footer de la home).

Ordenado por retorno/esfuerzo:

| # | Palanca | Retorno | Esfuerzo | Cuándo |
|---|---|---|---|---|
| 1 | **Arreglar el canonical de los 2 posts de Dev.to** (Q1) | Alto | Muy bajo | **2 semanas** |
| 2 | **Puente GitHub Lite:** en `Sevillanitto/ai-phishing-detector`, añadir descripción, *homepage* = `https://www.getkibbo.com/ai-phishing-detector`, topics (`phishing`, `claude-api`, `cloudflare-workers`, `chrome-extension`) y, en el README, una sección "Full version" con un enlace visible (hoy el README no menciona getkibbo; solo hay un `PRO_URL` opcional en `config.js`). Poner en el README un enlace al tutorial del blog. | Alto | Bajo | **2 semanas** |
| 3 | **Enlaces visibles en los posts de Dev.to que ya existen.** Los 7 artículos técnicos ya están publicados en Dev.to (junio), pero **7 de los 8 posts no tienen ningún enlace a getkibbo en el cuerpo** (solo el de suplementos enlaza a `/supplement-analyzer`). El canonical no es un enlace que lea el usuario. Añadir en cada post un enlace contextual a la página de producto y otro al artículo original. | Medio-alto | Bajo | **2 semanas** |
| 3b | **Cross-posting de lo nuevo, solo contenido técnico:** cada artículo del calendario, siempre **después** de publicarlo en el blog y con `canonical_url` al blog. **No** volcar los 118 exports de consumo de `devto/`: son off-topic para la audiencia de Dev.to y no suman. | Medio | Bajo | Continuo |
| 4 | **Show HN del repo Lite** ("Show HN: A self-hosted LLM phishing checker with a Cloudflare Worker proxy"). HN premia el código abierto y el "cómo lo hice"; el enlace al sitio va en el README, no como pitch. | Alto si funciona / variable | Bajo | **2 semanas** (tras el #2) |
| 5 | **Listas "awesome" y directorios dev:** PRs a listas curadas relevantes (privacidad, extensiones de navegador, recursos de seguridad) con el repo Lite y las comparativas. AlternativeTo (fichas de cada extensión como alternativa a Consent-O-Matic, Keepa, Honey). SaaSHub. | Medio | Bajo | **2 semanas → 2 meses** |
| 6 | **Embeds de calculadoras:** outreach a 20–30 blogs de viajes y de finanzas personales ofreciendo el embed de la calculadora de retrasos de vuelos o de descuentos reales. Cada embed trae el enlace de atribución. | Medio-alto (consumo) | Medio | **2–3 meses** |
| 7 | **Investigaciones y datasets como link bait:** enviar cada investigación con dataset a newsletters de datos y consumo, a periodistas del sector (aerolíneas, streaming, sanidad) y a subreddits de datos (r/dataisbeautiful exige visualizaciones). | Alto (consumo) | Medio | **2–3 meses** |
| 8 | **Launches escalonados en Product Hunt:** un producto cada 4–6 semanas, empezando por el que tenga comparativa y demo visual (Dark Patterns Detector o Cookie Consent Equalizer). Preparar GIF, primer comentario del maker y página de producto mejorada (R3) **antes**. | Medio | Medio | **2–3 meses** (tras R3) |
| 9 | **Indie Hackers:** posts de "building in public" con números reales (tráfico, ventas del código fuente, qué funcionó en SEO). IH premia la transparencia, no el pitch. | Medio | Bajo-medio | **2–3 meses** |
| 10 | **Reddit y foros de privacidad** (r/privacy, r/webdev, r/chrome_extensions, r/SideProject, foro de PrivacyGuides). Solo respondiendo a hilos donde la herramienta o el artículo resuelven la duda. r/privacy y PrivacyGuides penalizan la autopromoción. | Bajo-medio | Medio (continuo) | **2–3 meses**, con cuidado |

**Descartar por ahora (prematuro o contraproducente):**
- **Comprar enlaces, PBNs o "guest posts" en sitios genéricos:** riesgo de penalización manual.
- **Envíos masivos a 100+ directorios:** enlaces de bajo valor y posible huella de spam.
- **Lanzar los 7 productos a la vez en Product Hunt:** diluye el voto y no hay páginas de producto preparadas.
- **Publicar en Medium además de Dev.to:** otra copia más que gestionar con canonical, para poco retorno.
- **Chrome Web Store como palanca SEO:** los enlaces de la ficha son `nofollow`. Solo tendría sentido si publicas versiones gratuitas o Lite como canal de distribución (decisión de producto, no de SEO).

---

## 5. Qué haría primero (orden propuesto, pendiente de confirmación)

1. **Q1 + backlinks #1 y #3:** corregir el canonical de los 2 posts de Dev.to y añadir un enlace visible al producto en los 7 posts que no tienen ninguno. Lo haces tú en Dev.to; unos 20 minutos en total.
2. **Q2 + Q3:** enlazar los 7 artículos técnicos a sus páginas de producto y meter "Developer Tools" en el footer/nav. Es un reemplazo por script y tarda menos de 1 hora.
3. **Backlink #2:** README, descripción, homepage y topics del repo `ai-phishing-detector`.
4. **Quick wins técnicos Q4–Q8:** `authors.html`, enlaces rotos, huérfanas, `/article-template` y el 308 del dominio sin www.
5. **R1 (checklists pre-renderizadas) y R2 (heros WebP):** los dos cambios técnicos de mayor impacto sitewide, con verificación antes y después.
6. Pedir los exports de Search Console (sección 0) para priorizar R6 (titles) y R8 (versiones por país) con datos reales.
