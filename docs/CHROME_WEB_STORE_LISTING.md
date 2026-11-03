# Chrome Web Store Listing Copy & Metadata

> **Extension Name:** DeepSeek StreamArchive  
> **Package ID:** `deepseek-stream-archive`  
> **Version:** `0.1.0`  
> **Target Manifest:** Manifest V3 (`chrome-mv3`)  
> **Audited Date:** 2026-11-03  

---

## 1. Store Metadata Summary

| Store Field | Value | Constraints / Compliance |
|---|---|---|
| **Extension Name** | `DeepSeek StreamArchive` | <= 45 characters (actual: 23 chars) |
| **Short Description** | `Preserve, recover and archive DeepSeek responses locally while they stream.` | <= 132 characters (actual: 74 chars) |
| **Category** | `Productivity` (Secondary: `Developer Tools`) | Accurate category classification |
| **Language** | English (United States) & Russian | Bilingual support |
| **Privacy Policy URL** | `https://github.com/MalenkiySolovey/deepseek-stream-archive/blob/main/PRIVACY.md` | Publicly accessible stable URL |
| **Support URL** | `https://github.com/MalenkiySolovey/deepseek-stream-archive/issues` | Public GitHub issue tracker |
| **Homepage URL** | `https://github.com/MalenkiySolovey/deepseek-stream-archive` | Public GitHub repository |

---

## 2. English Store Description

### 2.1 Short Description (132 char limit)
```text
Preserve, recover and archive DeepSeek responses locally while they stream.
```

### 2.2 Detailed English Description

```text
DeepSeek StreamArchive is a local-first browser extension that records DeepSeek responses in real time as they stream, preserves revisions before filtering or connection loss, and provides a full-featured local archive right in your browser.

Never lose a generated answer again because of a sudden network dropout, client abort, or post-generation replacement.

============================================================
IMPORTANT PRODUCT BOUNDARY & HONESTY STATEMENT
============================================================
StreamArchive can only preserve content that actually reached your browser client. It cannot recover or recreate text that DeepSeek's servers filtered, truncated, or terminated before transmitting.

============================================================
CORE CAPABILITIES
============================================================

1. PASSIVE REAL-TIME STREAM ARCHIVING
• Captures Server-Sent Events (SSE) token-by-token across both Fetch and XMLHttpRequest.
• Zero interference with normal browsing: stream observation is passive and non-blocking.
• Preserves intermediate reasoning chains (DeepThink) alongside final answer text.

2. FORENSIC REVISION RECOVERY
• Automatically detects retraction events (such as content filters, network interruptions, and user stops).
• Freezes the complete, unredacted pre-filter answer as an immutable "last-good" revision in local storage.
• Displays clear trust markers indicating when an answer was rescued before replacement.

3. SVELTE 5 SIDE PANEL ARCHIVE BROWSER
• Native Chrome Side Panel interface accessible directly alongside your chats.
• Explore complete conversation histories with multi-branch navigation (Branch X of Y).
• Search across all locally archived responses with instant full-text filtering.
• Inspect collapsible DeepThink reasoning traces and chronological revision timelines.

4. IN-PAGE RECOVERY PRESENTATION
• Read rescued answers directly inside the DeepSeek chat window via an isolated closed Shadow DOM.
• Fully preserves DeepSeek's native action toolbar (Copy, Regenerate, Like, Dislike, Read aloud, Share).
• Dynamic switching between non-intrusive floating badges and inline chat presentation.

5. BRANCH-AWARE CONTEXT CONTINUITY (OPTIONAL)
• When an assistant response was interrupted or omitted from server memory, Context Continuity can restore missing context into your next query.
• STRICTLY OFF BY DEFAULT: Requires explicit user consent before any text is included.
• SAFE SINGLE-USE DELIVERY (manual_next): Arms for a single message with automatic disarming.
• TRANSPARENT PREVIEW: Inspect the exact text, character count, and boundary markers before sending.
• NEVER SENDS AUTONOMOUSLY: StreamArchive only augments a message that you actively send.

6. DATA PORTABILITY & LOCAL RETENTION
• Export individual threads to clean Markdown (.md) or structured JSON (.json).
• Create compressed, versioned full-archive backups (.streamarchive.jsonl.gz).
• Atomic restore with decompression-bomb protection and rollback guarantees.
• Configurable raw stream retention policies (Forever, 30, 90, 180 days) with Protected Evidence Shield.

============================================================
PRIVACY & SECURITY GUARANTEES
============================================================
• 100% LOCAL-FIRST: Your conversations are stored inside your browser's extension-origin IndexedDB sandbox.
• ZERO CLOUD BACKEND: We run no servers, no remote databases, and no cloud accounts.
• ZERO TELEMETRY: No analytics, no tracking pixels, and no third-party network calls.
• ZERO CREDENTIAL SCRAPING: We never collect, inspect, or store passwords, cookies, or authorization tokens.
• NO REMOTE CODE: All extension logic is statically packaged in compliance with Manifest V3.

============================================================
DISCLAIMER & INDEPENDENT PROJECT NOTICE
============================================================
DeepSeek StreamArchive is an independent community open-source project and is not affiliated with, endorsed by, or sponsored by DeepSeek. DeepSeek is a registered trademark of its respective owners.

Source code, issue tracker, and documentation:
https://github.com/MalenkiySolovey/deepseek-stream-archive
```

---

## 3. Russian Store Description (Русскоязычное описание)

### 3.1 Краткое описание (до 132 символов)
```text
Локальное сохранение, восстановление и архивация ответов DeepSeek прямо во время генерации потока.
```

### 3.2 Подробное русскоязычное описание

```text
DeepSeek StreamArchive — локальное расширение для браузера, сохраняющее ответы DeepSeek в реальном времени во время их генерации, защищающее ревизии ответов от фильтрации или обрывов связи и предоставляющее полноценный локальный архив прямо в боковой панели.

Больше не теряйте сгенерированные ответы из-за внезапного разрыва сети, ручной остановки или замены текста после завершения генерации.

============================================================
ЧЕСТНОЕ ЗАЯВЛЕНИЕ О ГРАНИЦАХ ВОЗМОЖНОСТЕЙ
============================================================
StreamArchive может сохранить только те данные, которые фактически достигли вашего браузера. Расширение не может восстановить или воссоздать текст, который серверы DeepSeek отфильтровали или заблокировали до отправки в браузер.

============================================================
ОСНОВНЫЕ ВОЗМОЖНОСТИ
============================================================

1. ПАССИВНАЯ АРХИВАЦИЯ ПОТОКА В РЕАЛЬНОМ ВРЕМЕНИ
• Захватывает события Server-Sent Events (SSE) токен за токеном через Fetch и XMLHttpRequest.
• Не мешает обычной работе: пассивное наблюдение без задержек и изменения запросов.
• Сохраняет промежуточные цепочки рассуждений (DeepThink) вместе с итоговым ответом.

2. ФОРЕНЗИК-ВОССТАНОВЛЕНИЕ РЕВИЗИЙ
• Автоматически обнаруживает события фильтрации, обрывы сети и ручные отмены генерации.
• Фиксирует полный неотредактированный ответ до фильтрации как неизменяемую ревизию в локальном хранилище.
• Отображает понятные метки доверия с указанием причины и времени спасения ответа.

3. АРХИВНЫЙ БРАУЗЕР В БОКОВОЙ ПАНЕЛИ НА SVELTE 5
• Нативный интерфейс Side Panel прямо рядом с вашим диалогом.
• Просмотр истории с поддержкой ветвления ответов (Ветка X из Y).
• Мгновенный полнотекстовый поиск по всем сохранённым локально ответам.
• Разворачиваемый блок рассуждений DeepThink и хронологическая лента ревизий.

4. ОТОБРАЖЕНИЕ ВОССТАНОВЛЕННЫХ ОТВЕТОВ В ЧАТЕ
• Возможность читать спасённые ответы прямо внутри окна чата через изолированный Shadow DOM.
• Полная сохранность нативной панели действий DeepSeek (Копировать, Перегенерировать, Озвучить и т.д.).
• Быстрое переключение между плавающими карточками и встроенным отображением в диалоге.

5. НЕПРЕРЫВНОСТЬ КОНТЕКСТА С УЧЁТОМ ВЕТОК (ОПЦИОНАЛЬНО)
• Если ответ ассистента был прерван или отсутствует в серверной истории, непрерывность контекста позволяет безопасно передать спасённый текст в ваш следующий запрос.
• СТРОГО ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ: Требует явного согласия пользователя.
• БЕЗОПАСНЫЙ РАЗОВЫЙ ВЗВОД (manual_next): Активируется на одно сообщение с автоматическим снятием взвода.
• ПРОЗРАЧНЫЙ ПРЕДПРОСМОТР: Показывает точный текст, объём символов и маркеры до отправки.
• НИКОГДА НЕ ОТПРАВЛЯЕТ ЗАПРОСЫ САМОСТОЯТЕЛЬНО: Дополняет только то сообщение, которое отправляет пользователь.

6. ПОРТАТИВНОСТЬ ДАННЫХ И ЛОКАЛЬНОЕ УПРАВЛЕНИЕ ХРАНИЛИЩЕМ
• Экспорт диалогов в чистый Markdown (.md) или структурированный JSON (.json).
• Создание сжатых резервных копий всего архива (.streamarchive.jsonl.gz).
• Атомарное восстановление с защитой от декомпрессионных бомб и гарантией отката.
• Настраиваемая политика очистки сырых потоков (Бессрочно, 30, 90, 180 дней) с защитой спасённых ответов.

============================================================
ГАРАНТИИ БЕЗОПАСНОСТИ И КОНФИДЕНЦИАЛЬНОСТИ
============================================================
• 100% ЛОКАЛЬНОЕ ХРАНЕНИЕ: Все диалоги хранятся в изолированной базе данных IndexedDB вашего браузера.
• НИКАКИХ СЕРВЕРОВ И ОБЛАКА: У нас нет серверов, удалённых баз данных и учётных записей.
• НИКАКОЙ ТЕЛЕМЕТРИИ: Никакой аналитики, трекеров и сторонних сетевых запросов.
• НИКАКОГО СБОРА ПАРОЛЕЙ И ТОКЕНОВ: Мы никогда не читаем и не сохраняем пароли, cookies или токены авторизации.
• ОТСУТСТВИЕ УДАЛЁННОГО КОДА: Весь код расширения поставляется в статическом пакете по стандартам Manifest V3.

============================================================
УВЕДОМЛЕНИЕ О НЕЗАВИСИМОМ ПРОЕКТЕ
============================================================
DeepSeek StreamArchive — независимый проект сообщества с открытым исходным кодом, который не связан с компанией DeepSeek, не финансируется и не одобряется ею. DeepSeek является зарегистрированным товарным знаком соответствующих правообладателей.

Исходный код, отчёты об ошибках и документация:
https://github.com/MalenkiySolovey/deepseek-stream-archive
```

---

## 4. Notes for Chrome Web Store Reviewers (Reviewer Instructions)

### 4.1 Single-Purpose Overview
> DeepSeek StreamArchive is a specialized local-first conversation archiver and revision preservation layer for the DeepSeek chat web application. All features—passive streaming capture, history reconciliation, local revision inspection in the Side Panel, data export, and optional context continuity—directly serve the single purpose of preserving and recovering DeepSeek responses.

### 4.2 Manifest Permissions Justification
- **`storage`:** Required strictly to persist user preferences (language, presentation mode, retention policy, Context Continuity toggles) in `chrome.storage.local`.
- **`sidePanel`:** Required to render the Side Panel interface (`sidepanel.html`), providing users an integrated workspace to browse, search, and export archived conversations alongside their chats.
- **Host Permission `https://chat.deepseek.com/*`:** Strictly limited to the official DeepSeek chat domain. Content scripts observe streaming completion responses in real time and render non-destructive in-page recovery markers via closed Shadow DOM.

### 4.3 MAIN-World Content Script Justification (`interceptor.js`)
StreamArchive includes a script executing in the `MAIN` world (`entrypoints/interceptor.content.ts`).
- **Why is this necessary?** Modern single-page web applications consume streaming responses via the page's native `window.fetch` and `window.XMLHttpRequest` instances. Isolated-world content scripts cannot intercept in-flight streaming chunks from native page calls without monkeypatching within the page execution realm.
- **Security Boundaries:**
  - The MAIN script has **zero access** to privileged `chrome.*` extension APIs.
  - Communication between the MAIN world and the ISOLATED extension world uses strictly schema-validated `window.dispatchEvent` events.
  - Zero authentication headers, Bearer tokens, passwords, or cookies are captured or transmitted across the bridge.

### 4.4 Context Continuity Safeguards
- Context Continuity defaults strictly to `OFF` (`enabled: false`).
- When disabled, outgoing request payloads are 100% byte-identical and unmodified.
- When enabled, it operates in `manual_next` mode by default, requiring the user to explicitly click "Use continuity for next message" before a single prompt is augmented.
- StreamArchive **never** clicks Send or generates requests autonomously. Augmentation occurs solely on user-initiated form submissions.

### 4.5 Testing Instructions for Reviewer
1. Load the unpacked extension into Chrome.
2. Navigate to `https://chat.deepseek.com/` and log in or start a chat.
3. Click the extension toolbar icon to open the Side Panel. The conversation list and search bar will load cleanly.
4. Send any question in DeepSeek. The Side Panel will record the streaming response in real time.
5. In the Side Panel Settings tab, observe the local storage estimate and verify that all data is stored strictly in client-side IndexedDB.
