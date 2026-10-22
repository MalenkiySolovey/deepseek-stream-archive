export type SupportedLocale = 'en' | 'ru';

export const translations = {
  en: {
    appTitle: 'DeepSeek StreamArchive',
    tabArchive: 'Archive',
    tabDiagnostics: 'Diagnostics',
    tabSettings: 'Settings',

    // Archive list
    searchPlaceholder: 'Search saved conversations...',
    conversationsTitle: 'Saved Conversations',
    totalConversations: 'total',
    emptyConversations: 'No archived conversations found',
    emptyConversationsSub: 'Live DeepSeek sessions and historical chats will appear here once captured.',
    loadMore: 'Load more conversations',
    refresh: 'Refresh',
    loading: 'Loading archive...',
    provisional: 'Provisional (Live)',
    reconciled: 'Reconciled',
    hasFiltered: 'Shield: Censored text preserved',
    messagesCount: 'messages',

    // Conversation Detail
    backToList: 'Back to conversations',
    conversationDetail: 'Conversation Detail',
    conversationId: 'ID',
    remoteId: 'Remote ID',
    noMessages: 'No messages recorded in this conversation yet.',
    branchXofY: 'Branch',
    of: 'of',
    prevBranch: 'Previous branch',
    nextBranch: 'Next branch',
    unresolvedParent: 'Branch root / parent not linked',
    roleUser: 'User',
    roleAssistant: 'DeepSeek Assistant',

    // Assistant message & revision
    thinkingTitle: 'Reasoning Process (Thinking)',
    thinkingChars: 'chars',
    copyText: 'Copy text',
    copiedText: 'Copied!',
    revisionsTitle: 'Revision History',
    revisionIndex: 'Rev',
    sourceLive: 'Live stream',
    sourceHistory: 'Server history',
    sourceReplay: 'Raw journal replay',
    sourceSynthetic: 'Synthetic',
    lastGoodBadge: 'Last Good (Pre-filter)',
    finalBadge: 'Final',
    viewRevision: 'View this revision',
    activeRevision: 'Active',

    // Recovery Card
    recoveryCardTitle: 'Censored Response Preserved',
    recoveryCardDesc: 'DeepSeek content filter triggered. The original uncensored response was safely captured prior to deletion.',
    copyPreservedText: 'Copy Uncensored Answer',
    censoredTemplate: 'Server filtered placeholder',

    // Settings
    settingsTitle: 'Settings & Storage',
    languageSelect: 'Interface Language',
    aboutTitle: 'About StreamArchive',
    aboutDesc: 'Local-first, crash-durable forensic recorder and recovery extension for DeepSeek web streams.',
    storageNotice: 'All data is stored locally in your browser IndexedDB with zero external tracking.',
  },
  ru: {
    appTitle: 'DeepSeek StreamArchive',
    tabArchive: 'Архив',
    tabDiagnostics: 'Диагностика',
    tabSettings: 'Настройки',

    // Archive list
    searchPlaceholder: 'Поиск сохранённых диалогов...',
    conversationsTitle: 'Сохранённые диалоги',
    totalConversations: 'всего',
    emptyConversations: 'Сохранённые диалоги не найдены',
    emptyConversationsSub: 'Прямые стримы и сессии DeepSeek появятся здесь автоматически после захвата.',
    loadMore: 'Загрузить ещё',
    refresh: 'Обновить',
    loading: 'Загрузка архива...',
    provisional: 'Live-поток (предварительно)',
    reconciled: 'Сверено с сервером',
    hasFiltered: 'Щит: Текст сохранён до цензуры',
    messagesCount: 'сообщений',

    // Conversation Detail
    backToList: 'Назад к списку',
    conversationDetail: 'Детали диалога',
    conversationId: 'ID',
    remoteId: 'Серверный ID',
    noMessages: 'В этом диалоге пока нет сообщений.',
    branchXofY: 'Ветка',
    of: 'из',
    prevBranch: 'Предыдущая ветка',
    nextBranch: 'Следующая ветка',
    unresolvedParent: 'Начало ветки / родительское сообщение не привязано',
    roleUser: 'Пользователь',
    roleAssistant: 'Ассистент DeepSeek',

    // Assistant message & revision
    thinkingTitle: 'Процесс рассуждения (Thinking)',
    thinkingChars: 'симв.',
    copyText: 'Копировать',
    copiedText: 'Скопировано!',
    revisionsTitle: 'История ревизий ответа',
    revisionIndex: 'Рев.',
    sourceLive: 'Live-стрим',
    sourceHistory: 'История с сервера',
    sourceReplay: 'Реплей из Raw Journal',
    sourceSynthetic: 'Синтетическая',
    lastGoodBadge: 'Last Good (До цензуры)',
    finalBadge: 'Финальная',
    viewRevision: 'Показать эту версию',
    activeRevision: 'Активна',

    // Recovery Card
    recoveryCardTitle: 'Ответ сохранён до цензуры',
    recoveryCardDesc: 'Сработал фильтр DeepSeek CONTENT_FILTER. Исходный ответ модели был перехвачен и сохранён в локальный архив до удаления сервером.',
    copyPreservedText: 'Копировать исходный ответ',
    censoredTemplate: 'Серверный шаблон цензуры',

    // Settings
    settingsTitle: 'Настройки и Хранилище',
    languageSelect: 'Язык интерфейса',
    aboutTitle: 'О расширении StreamArchive',
    aboutDesc: 'Локальный, устойчивый к сбоям журнал и инструмент восстановления стримов DeepSeek.',
    storageNotice: 'Все данные хранятся исключительно локально в браузере (IndexedDB) без отправки на сторонние серверы.',
  },
} as const;

export type TranslationKey = keyof (typeof translations)['en'];
