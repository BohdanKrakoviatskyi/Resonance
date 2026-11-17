use crate::models::Lang;

macro_rules! define_keys {
    ($($variant:ident => ($ru:expr, $en:expr)),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Key {
            $($variant,)*
        }

        pub fn lookup(key: Key) -> (&'static str, &'static str) {
            match key {
                $(Key::$variant => ($ru, $en),)*
            }
        }
    };
}

define_keys! {
    Home => ("Главная", "Home"),
    Search => ("Поиск", "Search"),
    Favorites => ("Избранное", "Favorites"),
    Playlists => ("Плейлисты", "Playlists"),
    Appearance => ("Оформление", "Appearance"),
    Providers => ("Музыкальные сервисы", "Music providers"),
    Settings => ("Настройки", "Settings"),
    SettingsSub => ("Управление оформлением, сервисами и параметрами приложения", "Manage appearance, music services and app preferences"),
    AppearanceSub => ("Стекло, цвета, фон и анимации — всё под вас", "Glass, colors, background and motion — make it yours"),
    ProvidersSub => ("Подключение SoundCloud и YouTube Music", "Connect SoundCloud and YouTube Music"),
    ProvidersPageDesc => ("Подключайте музыкальные сервисы через отдельное окно входа. Resonance хранит сессию каждого провайдера локально в папке данных приложения.", "Connect music services in a dedicated sign-in window. Resonance keeps each provider session in the local app data directory and never stores credentials in the page or in source control."),
    ProviderStatusConnected => ("Подключено", "Connected"),
    ProviderStatusNotConnected => ("Не подключено", "Not connected"),
    ProviderStatusChecking => ("Проверка…", "Checking…"),
    ProviderAccount => ("Аккаунт", "Account"),
    ProviderRefresh => ("Обновить библиотеку", "Refresh library"),
    ProviderDisconnect => ("Отключить", "Disconnect"),
    ScDescription => ("Войдите в SoundCloud в отдельном окне браузера.", "Sign in to SoundCloud in a dedicated browser window."),
    ScNote => ("Нажмите «Войти через SoundCloud». Resonance автоматически считает токен сессии и сохранит его локально.", "Press Login with SoundCloud. Resonance captures the client ID and session token from SoundCloud API requests, validates the token, and stores the session in the local app data directory."),
    ScLoginBtn => ("Войти через SoundCloud", "Login with SoundCloud"),
    ScWaitingBtn => ("Ожидание SoundCloud…", "Waiting for SoundCloud…"),
    ScUseTokenBtn => ("Использовать токен", "Use existing access token"),
    ScSignInWindowMsg => ("Завершите вход в открывшемся окне SoundCloud…", "Finish signing in in the SoundCloud window…"),
    ScConnectedMsg => ("SoundCloud подключён.", "SoundCloud connected."),
    ScRefreshedMsg => ("Подключение обновлено.", "Connection refreshed."),
    YtDescription => ("Войдите в YouTube Music в отдельном окне браузера.", "Sign in to YouTube Music in a dedicated browser window."),
    YtNote => ("Resonance откроет YouTube Music и сохранит сессию после входа в аккаунт. Ваша библиотека доступна в режиме чтения, а треки воспроизводятся напрямую через встроенный YouTube-движок.", "Resonance opens YouTube Music, waits for the signed-in account request, and reads the session cookie from the embedded window. Your library is read-only, and tracks stream directly through the built-in YouTube engine."),
    YtLoginBtn => ("Войти через YouTube Music", "Login with YouTube Music"),
    YtWaitingBtn => ("Ожидание YouTube Music…", "Waiting for YouTube Music…"),
    YtSignInWindowMsg => ("Завершите вход в YouTube Music в открывшемся окне…", "Finish signing in to YouTube Music in the opened window…"),
    YtConnectedMsg => ("YouTube Music подключён.", "YouTube Music connected."),
    YtRefreshedMsg => ("Библиотека YouTube Music обновлена.", "YouTube Music library refreshed."),
    ProviderDisconnectedMsg => ("Сервис отключён.", "Provider disconnected."),
    Updates => ("Обновление", "Updates"),
    UpdateAvailable => ("Доступно обновление", "Update available"),
    UpdateUpToDate => ("Установлена последняя версия", "You are on the latest version"),
    UpdateChecking => ("Проверяем наличие обновлений…", "Checking for updates…"),
    UpdateCurrentVer => ("Текущая версия", "Current version"),
    UpdateLatestVer => ("Новая версия", "Latest version"),
    UpdateInstallBtn => ("Обновить и перезапустить", "Update and restart"),
    UpdateCheckAgainBtn => ("Проверить снова", "Check again"),
    SplashChecking => ("Resonance обновляется", "Resonance is updating"),
    SplashUpdating => ("Обновляем Resonance…", "Updating Resonance…"),
    SplashInstalling => ("Перезапускаем Resonance…", "Restarting Resonance…"),
    UpdateStartedTitle => ("Установка обновления", "Installing update"),
    UpdateStartedText => ("Скачивание новой версии началось. Ваши аккаунты YouTube Music и SoundCloud, а также все настройки сохранены. Если установщик не сможет автоматически удалить старую версию программы, нажмите кнопку удаления ниже.", "The new version download has started. Your YouTube Music and SoundCloud accounts and all settings are preserved. If the installer cannot remove the old version automatically, use the uninstall button below."),
    UninstallApp => ("Удалить программу", "Uninstall application"),
    UninstallAppSub => ("Удалить Resonance с компьютера (аккаунты и настройки сохранятся для следующей установки)", "Remove Resonance from your computer (accounts and settings will be kept for future installs)"),
    UninstallTitle => ("Удаление программы", "Uninstall application"),
    UninstallText => ("Программа Resonance будет удалена с вашего компьютера. Ваши данные и сессии YouTube Music, SoundCloud, а также настройки оформления будут сохранены для обновлённой версии.", "Resonance will be uninstalled from your computer. Your YouTube Music and SoundCloud data, sessions, and appearance settings will be preserved for the updated version."),
    UninstallConfirmCheck => ("Я подтверждаю удаление программы", "I confirm uninstalling the application"),
    UninstallBtn => ("Удалить Resonance", "Uninstall Resonance"),
    ClearCacheApp => ("Очистить кэш", "Clear cache"),
    ClearCacheTitle => ("Очистка кэша", "Clear cache"),
    ClearCacheText => ("Будет очищен весь кэш приложения: скачанная музыка и обложки. Ваши аккаунты, плейлисты и настройки сохранятся, а музыка и обложки загрузятся заново при следующем открытии.", "The entire app cache will be cleared: downloaded music and artwork. Your accounts, playlists and settings are kept, and music and artwork will be re-downloaded when opened again."),
    ClearCacheConfirmCheck => ("Я подтверждаю очистку кэша", "I confirm clearing the cache"),
    ClearCacheBtn => ("Очистить кэш", "Clear cache"),
    ClearCacheDone => ("Кэш очищен", "Cache cleared"),
    ClearCacheError => ("Не удалось очистить кэш: {reason}", "Could not clear cache: {reason}"),
    CloseBtn => ("Закрыть", "Close"),
    NewPlaylist => ("Новый плейлист", "New playlist"),
    PlaylistName => ("Название плейлиста", "Playlist name"),
    ImportTabScratch => ("С нуля", "From scratch"),
    ImportTabImport => ("Импорт", "Import"),
    ImportModePlaylist => ("По ссылке", "By link"),
    ImportModeScLikes => ("Лайки SoundCloud", "SoundCloud Likes"),
    ImportLinkLabel => ("Ссылка на плейлист", "Playlist link"),
    ImportScUserLabel => ("Имя пользователя или ссылка SoundCloud", "SoundCloud username or link"),
    ImportCustomNameLabel => ("Название плейлиста (необязательно)", "Playlist name (optional)"),
    ImportSourcesHint => ("YouTube, YouTube Music, SoundCloud (плейлисты и /likes), Spotify, Deezer и Apple Music", "YouTube, YouTube Music, SoundCloud (playlists & /likes), Spotify, Deezer & Apple Music"),
    ImportScLikesHint => ("Импортирует публичные понравившиеся треки профиля SoundCloud в плейлист Resonance", "Imports public liked tracks from a SoundCloud profile into a Resonance playlist"),
    ImportPasteLinkFirst => ("Вставьте ссылку на плейлист", "Paste a playlist link first"),
    ImportEnterUserFirst => ("Введите ник или ссылку на профиль SoundCloud", "Enter a SoundCloud username or profile link"),
    ImportUnsupportedLink => ("Неподдерживаемая ссылка. Попробуйте YouTube, SoundCloud, Spotify, Deezer или Apple Music", "Unsupported link. Try YouTube, SoundCloud, Spotify, Deezer or Apple Music"),
    ImportAlreadyRunning => ("Импорт уже выполняется — дождитесь завершения или отмените текущий", "An import is already running — wait for it to finish or cancel it"),
    ImportStartBtn => ("Импортировать", "Import"),
    ImportFetching => ("Загружаем плейлист…", "Fetching playlist…"),
    ImportMatching => ("Подбираем треки {done} из {total}", "Matching tracks {done} of {total}"),
    ImportFinalizing => ("Сохраняем плейлист…", "Saving playlist…"),
    ImportNeedsReview => ("Проверьте {count} спорных треков", "Review {count} uncertain tracks"),
    ImportNeedsReviewSub => ("Нужно подтверждение ({count})", "Needs review ({count})"),
    ImportReviewBtn => ("Проверить", "Review"),
    ImportReviewTitle => ("Проверка совпадений", "Review matched tracks"),
    ImportReviewSummary => ("Совпало {matched} из {total} · На проверке: {pending}", "{matched} of {total} matched · Pending review: {pending}"),
    ImportSelectAll => ("Выбрать все", "Select all"),
    ImportDeselectAll => ("Снять все", "Deselect all"),
    ImportSkipAll => ("Пропустить спорные", "Skip uncertain"),
    ImportApplyBtn => ("Добавить ({count})", "Add ({count})"),
    ImportNoCandidate => ("Подходящий трек не найден", "No matching track found"),
    ImportSearchAltBtn => ("Найти вручную", "Search manually"),
    ImportSearchPlaceholder => ("Исполнитель и название трека", "Artist and track title"),
    ImportSearchEmpty => ("Ничего не найдено — попробуйте другой запрос", "Nothing found — try another query"),
    ImportSkippedBadge => ("Пропущен", "Skipped"),
    ImportReasonLow => ("Низкое совпадение", "Low match"),
    ImportReasonAmbiguous => ("Есть варианты", "Ambiguous"),
    ImportReasonDuration => ("Другая длительность", "Duration diff"),
    ImportReasonNone => ("Не найден", "Not found"),
    ImportReasonFailed => ("Ошибка поиска", "Search error"),
    ImportCancelled => ("Импорт отменён", "Import cancelled"),
    ImportDoneToast => ("Плейлист «{name}» импортирован ({count})", "Imported \"{name}\" ({count})"),
    ImportOpenPlaylist => ("Открыть", "Open"),
    ImportFailed => ("Не удалось импортировать плейлист", "Failed to import playlist"),
    ImportPreviewPlay => ("Прослушать отрывок", "Preview track"),
    ImportPreviewPause => ("Остановить прослушивание", "Stop preview"),
    ImportNoTracksSelected => ("Ни один трек не выбран для импорта", "No tracks selected for import"),
    Create => ("Создать", "Create"),
    Cancel => ("Отмена", "Cancel"),
    Save => ("Сохранить", "Save"),
    Rename => ("Переименовать", "Rename"),
    Delete => ("Удалить", "Delete"),
    DeletePlaylistQ => ("Удалить плейлист?", "Delete playlist?"),
    DeletePlaylistText => ("«{name}» будет удалён без возможности восстановления.", "\"{name}\" will be permanently deleted."),
    PlaylistCreated => ("Плейлист «{name}» создан", "Playlist \"{name}\" created"),
    Expand => ("Развернуть", "Expand"),
    Collapse => ("Свернуть", "Collapse"),
    Menu => ("Меню", "Menu"),
    Back => ("Назад", "Back"),
    NowPlaying => ("Сейчас играет", "Now playing"),
    NothingPlaying => ("Тишина", "Nothing playing"),
    PickSomething => ("Выберите трек, и здесь появятся обложка и текст", "Pick a track — artwork and lyrics will show up here"),
    Lyrics => ("Текст", "Lyrics"),
    UpNext => ("Далее", "Up next"),
    QueueEmpty => ("Дальше в очереди ничего нет", "Nothing else in the queue"),
    NoLyrics => ("Текст для этого трека не найден", "No lyrics found for this track"),
    LyricsLoading => ("Ищем текст…", "Looking for lyrics…"),
    WrongLyricsBtn => ("Другой текст", "Change lyrics"),
    LyricsSearchTitle => ("Поиск текста песни", "Search lyrics"),
    LyricsSearchPlaceholder => ("Исполнитель — Название", "Artist — Track title"),
    LyricsSyncedBadge => ("Синхр.", "Synced"),
    LyricsResetManual => ("Вернуть автовыбор", "Reset to auto"),
    PreviewNote => ("Играет превью 30 сек · текст полной версии", "30s preview · full song lyrics"),
    Instrumental => ("Инструментальный трек", "Instrumental track"),
    Like => ("Нравится", "Like"),
    Unlike => ("Убрать из избранного", "Remove from favorites"),
    Dislike => ("Не нравится", "Dislike"),
    Undislike => ("Убрать дизлайк", "Remove dislike"),
    AddToPlaylist => ("Добавить в плейлист", "Add to playlist"),
    AddedTo => ("Добавлено в «{name}»", "Added to \"{name}\""),
    RemovedFrom => ("Удалено из «{name}»", "Removed from \"{name}\""),
    AddedFav => ("Добавлено в избранное", "Added to favorites"),
    RemovedFav => ("Удалено из избранного", "Removed from favorites"),
    DislikedMsg => ("Понятно, больше не предложим", "Got it — we'll skip this one"),
    Undo => ("Отменить", "Undo"),
    FullscreenLyrics => ("Текст на весь экран", "Fullscreen lyrics"),
    ExitFullscreen => ("Свернуть", "Close"),
    Fullscreen => ("Полноэкранный режим", "Fullscreen"),
    Play => ("Слушать", "Play"),
    Pause => ("Пауза", "Pause"),
    Shuffle => ("Перемешать", "Shuffle"),
    Repeat => ("Повтор", "Repeat"),
    RepeatOne => ("Повтор трека", "Repeat one"),
    Next => ("Следующий", "Next"),
    Previous => ("Предыдущий", "Previous"),
    Volume => ("Громкость", "Volume"),
    Mute => ("Без звука", "Mute"),
    Seek => ("Позиция", "Seek"),
    ShowPanel => ("Показать «Сейчас играет»", "Show now playing"),
    HidePanel => ("Скрыть панель", "Hide panel"),
    GoodMorning => ("Доброе утро", "Good morning"),
    GoodAfternoon => ("Добрый день", "Good afternoon"),
    GoodEvening => ("Добрый вечер", "Good evening"),
    GoodNight => ("Доброй ночи", "Good night"),
    HomeSubtitle => ("Что послушаем сегодня?", "What are we listening to today?"),
    Featured => ("Трек дня", "Track of the day"),
    YourPlaylists => ("Ваши плейлисты", "Your playlists"),
    SoundcloudLibrary => ("Библиотека SoundCloud", "SoundCloud library"),
    SoundcloudLibrarySub => ("Плейлисты", "Playlists"),
    SoundcloudLiked => ("Понравившиеся", "Liked songs"),
    SoundcloudLoading => ("Загружаем SoundCloud…", "Loading SoundCloud…"),
    SoundcloudTracks => ("Треки SoundCloud", "SoundCloud tracks"),
    YtmusicLibrary => ("Библиотека YouTube Music", "YouTube Music library"),
    YtmusicLibrarySub => ("Плейлисты", "Playlists"),
    YtmusicLiked => ("Понравившиеся", "Liked songs"),
    YtmusicLoading => ("Загружаем YouTube Music…", "Loading YouTube Music…"),
    Moods => ("Настроение", "Moods"),
    Recent => ("Недавно играло", "Recently played"),
    SearchPlaceholder => ("Треки, артисты, альбомы", "Songs, artists, albums"),
    Browse => ("Обзор", "Browse all"),
    InLibrary => ("В библиотеке", "In your library"),
    FullTracks => ("Полные треки · SoundCloud", "Full tracks · SoundCloud"),
    Previews => ("Превью", "Previews"),
    NoResults => ("Ничего не нашлось", "Nothing found"),
    NoResultsText => ("Попробуйте другой запрос", "Try a different search"),
    LoadError => ("Не удалось загрузить", "Couldn't load results"),
    Retry => ("Повторить", "Retry"),
    ShowAll => ("Показать все", "Show all"),
    ShowLess => ("Свернуть", "Show less"),
    FavoritesEmpty => ("Пока пусто", "Nothing here yet"),
    FavoritesEmptyText => ("Нажимайте ♥ на треках, которые нравятся, — они соберутся здесь", "Tap ♥ on songs you love and they'll gather here"),
    FavoritesAll => ("Все", "All"),
    FavoritesSearchPlaceholder => ("Поиск в избранном", "Search favorites"),
    PlaylistSearchPlaceholder => ("Поиск в плейлисте", "Search playlist"),
    PlaylistEmptyText => ("Найдите музыку и добавьте её кнопкой «Добавить в плейлист»", "Find music and add it with \"Add to playlist\""),
    FindMusic => ("Найти музыку", "Find music"),
    Playlist => ("Плейлист", "Playlist"),
    Collection => ("Коллекция", "Collection"),
    NotFound => ("Плейлист не найден", "Playlist not found"),
    RemoveFromPlaylist => ("Убрать из плейлиста", "Remove from playlist"),
    PlayNext => ("Играть следующим", "Play next"),
    AddToQueue => ("Добавить в очередь", "Add to queue"),
    AddedToQueue => ("Добавлено в очередь", "Added to queue"),
    PlayingNext => ("Сыграет следующим", "Playing next"),
    GoToArtist => ("Найти артиста", "Find artist"),
    Preview => ("Превью", "Preview"),
    CantPlay => ("Не удалось воспроизвести трек", "Couldn't play this track"),
    SoundcloudFallbackNoMatch => ("SoundCloud не дал полный поток, а подходящий трек на YouTube не найден", "SoundCloud did not provide a full stream, and no matching YouTube track was found"),
    StreamFallbackFailed => ("Не удалось найти или запустить запасной поток: {reason}", "Could not find or start a fallback stream: {reason}"),
    Theme => ("Тема", "Theme"),
    Dark => ("Тёмная", "Dark"),
    Light => ("Светлая", "Light"),
    System => ("Системная", "System"),
    Glass => ("Эффект стекла", "Glass effect"),
    Liquid => ("Liquid Glass", "Liquid Glass"),
    Frosted => ("Матовое", "Frosted"),
    Off => ("Выключено", "Off"),
    LiquidDesc => ("Прозрачное, с преломлением и бликами", "Clear, with refraction and highlights"),
    FrostedDesc => ("Сильное размытие и мягкое зерно", "Heavy blur with a soft grain"),
    OffDesc => ("Плотные поверхности, максимум скорости", "Solid surfaces, maximum speed"),
    Blur => ("Размытие", "Blur"),
    Tint => ("Плотность тонировки", "Tint density"),
    Refraction => ("Преломление", "Refraction"),
    Background => ("Фон плеера", "Player background"),
    FromCover => ("Из обложки", "From artwork"),
    Color => ("Цвет", "Color"),
    Photo => ("Фото", "Photo"),
    BgPalette => ("Палитра", "Palette"),
    BgArtwork => ("Обложка", "Artwork"),
    UploadPhoto => ("Загрузить фото", "Upload photo"),
    ChangePhoto => ("Сменить фото", "Change photo"),
    RemovePhoto => ("Убрать", "Remove"),
    Dim => ("Затемнение", "Dim"),
    BgBlur => ("Размытие фона", "Background blur"),
    Accent => ("Акцентный цвет", "Accent color"),
    Custom => ("Свой", "Custom"),
    CustomColor => ("Свой цвет", "Custom color"),
    ColorStyle => ("Стиль палитры", "Palette style"),
    ColorStyleMetallicHint => ("При включённом металлическом эффекте используется хромированная стальная палитра", "Overridden by Metallic style while enabled"),
    Tonal => ("Тональный", "Tonal"),
    Vibrant => ("Яркий", "Vibrant"),
    Expressive => ("Экспрессивный", "Expressive"),
    Fidelity => ("Точный", "Fidelity"),
    Rainbow => ("Радуга", "Rainbow"),
    Fruit => ("Фруктовый", "Fruit salad"),
    Mono => ("Монохром", "Monochrome"),
    Neutral => ("Нейтральный", "Neutral"),
    MetallicMode => ("Металлический эффект", "Metallic style"),
    MetallicModeDesc => ("Хромированная стальная палитра с переливающимся металлическим бликом и бело-серебристыми акцентами", "Brushed steel & graphite palette with liquid metallic sheen and silver-white accents"),
    NeonAccent => ("Неоновый акцент на металле", "Neon accent"),
    NeonIntensity => ("Интенсивность неона", "Neon intensity"),
    Motion => ("Анимации", "Motion"),
    MotionExpressive => ("Экспрессивные", "Expressive"),
    MotionStandard => ("Спокойные", "Standard"),
    MotionReduced => ("Минимум", "Reduced"),
    Language => ("Язык", "Language"),
    Reset => ("Сбросить оформление", "Reset appearance"),
    CurrentScheme => ("Текущая схема", "Current scheme"),
    DynamicHint => ("Цвета меняются под обложку каждого играющего трека", "Colors follow the artwork of every track you play"),
    PhotoError => ("Фото применено, но не сохранится после перезагрузки", "Photo applied, but it won't persist after reload"),
    PhotoTooLarge => ("Анимированное изображение больше 8 МБ — выберите меньше", "Animated image is over 8 MB — pick a smaller one"),
    LibrarySaveError => ("Не удалось сохранить библиотеку: хранилище заполнено", "Couldn't save your library: storage is full"),
    Shortcuts => ("Горячие клавиши", "Keyboard shortcuts"),
    ShortcutsSub => ("Управление сочетаниями клавиш для плеера", "Customize keyboard shortcuts for playback and navigation"),
    AudioSettings => ("Звук", "Audio"),
    AudioSettingsSub => ("Нормализация громкости, кроссфейд и плавность переходов", "Loudness normalization, crossfade and transition curves"),
    AudioNormalization => ("Нормализация громкости", "Audio normalization"),
    AudioNormalizationDesc => ("Выравнивает громкость между тихими и громкими треками без клиппинга и искажений", "Balances loudness across quiet and loud tracks without clipping or distortion"),
    Enabled => ("Включено", "Enabled"),
    Disabled => ("Выключено", "Disabled"),
    TargetLoudness => ("Целевой уровень громкости", "Target loudness"),
    LoudnessQuiet => ("Тихий (-18 LUFS)", "Quiet (-18 LUFS)"),
    LoudnessNormal => ("Стандартный (-14 LUFS)", "Standard (-14 LUFS)"),
    LoudnessLoud => ("Громкий (-11 LUFS)", "Loud (-11 LUFS)"),
    Crossfade => ("Кроссфейд", "Crossfade"),
    CrossfadeDesc => ("Плавное сведение конца текущего трека с началом следующего", "Smoothly blends the end of the current track into the next one"),
    CrossfadeDurationLabel => ("Длительность перехода", "Transition duration"),
    CrossfadeCurveLabel => ("Кривая затухания (мягкость перехода)", "Transition curve (smoothness)"),
    CurveLinear => ("Линейная", "Linear"),
    CurveEqualPower => ("Мягкая (Equal Power)", "Smooth (Equal Power)"),
    CurveSCurve => ("Плавная (S-Curve)", "Ultra-smooth (S-Curve)"),
    CurveLinearDesc => ("Равномерное изменение громкости с постоянной скоростью", "Uniform linear volume transition"),
    CurveEqualPowerDesc => ("Равномощностная кривая (cos/sin) — исключает провал громкости в середине перехода (рекомендуется)", "Equal-power curve (cos/sin) — prevents volume dip at the midpoint (recommended)"),
    CurveSCurveDesc => ("S-образная синусоидальная огибающая — максимально незаметный старт и финал перехода", "S-shaped sine envelope — imperceptible start and end of the transition"),
    SecUnit => ("сек", "s"),
    Equalizer => ("Эквалайзер", "Equalizer"),
    EqPresetLabel => ("Пресет", "Preset"),
    EqFlat => ("Flat (По умолчанию)", "Flat"),
    EqBassBoost => ("Bass Boost", "Bass Boost"),
    EqVocal => ("Vocal", "Vocal"),
    EqRock => ("Rock", "Rock"),
    EqElectronic => ("Electronic", "Electronic"),
    EqCustom => ("Custom (Свой)", "Custom"),
    EqReset => ("Сбросить", "Reset"),
    BackToPlaying => ("К текущему треку", "Back to playing"),
    KbPlay => ("Пауза / воспроизведение", "Play / pause"),
    KbSeek => ("Перемотка ±5 сек", "Seek ±5s"),
    KbSeekBack => ("Перемотка назад", "Seek backward"),
    KbSeekForward => ("Перемотка вперёд", "Seek forward"),
    KbPrevious => ("Предыдущий трек", "Previous track"),
    KbNext => ("Следующий трек", "Next track"),
    KbSkip => ("Предыдущий / следующий трек", "Previous / next track"),
    KbLike => ("Нравится", "Like"),
    KbLyrics => ("Текст на весь экран", "Fullscreen lyrics"),
    KbMute => ("Выключить звук", "Mute"),
    KbSearch => ("Поиск", "Search"),
    ShortcutListening => ("Нажмите сочетание…", "Press a shortcut…"),
    ShortcutReset => ("Вернуть сочетание по умолчанию", "Restore default shortcut"),
    ShortcutDuplicate => ("Это сочетание уже назначено другому действию.", "This shortcut is already assigned to another action."),
    ShortcutRegisterError => ("Не удалось зарегистрировать глобальную клавишу.", "Could not register the global shortcut."),
    ShortcutStorageError => ("Не удалось сохранить настройки сочетаний.", "Could not save shortcut settings."),
    Min => ("мин", "min"),
    Hr => ("ч", "h"),
}

pub fn t(lang: Lang, key: Key) -> &'static str {
    let (ru, en) = lookup(key);
    match lang {
        Lang::Ru => ru,
        Lang::En => en,
    }
}

pub fn tf(lang: Lang, key: Key, vars: &[(&str, &str)]) -> String {
    let mut out = t(lang, key).to_string();
    for (k, v) in vars {
        let placeholder = format!("{{{k}}}");
        out = out.replace(&placeholder, v);
    }
    out
}

pub fn pick<'a>(lang: Lang, ru: &'a str, en: &'a str) -> &'a str {
    match lang {
        Lang::Ru => ru,
        Lang::En => en,
    }
}

pub fn tracks_label(lang: Lang, n: Option<i64>) -> String {
    let count = n.unwrap_or(0).max(0) as u64;
    if lang == Lang::En {
        let noun = if count == 1 { "track" } else { "tracks" };
        return format!("{count} {noun}");
    }
    let m10 = count % 10;
    let m100 = count % 100;
    let word = if m10 == 1 && m100 != 11 {
        "трек"
    } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
        "трека"
    } else {
        "треков"
    };
    format!("{count} {word}")
}

pub fn dur_label(lang: Lang, sec: f64) -> String {
    let total_min = if sec.is_finite() && sec > 0.0 {
        (sec / 60.0).round() as u64
    } else {
        0
    };
    if total_min < 60 {
        return format!("{total_min} {}", t(lang, Key::Min));
    }
    format!(
        "{} {} {} {}",
        total_min / 60,
        t(lang, Key::Hr),
        total_min % 60,
        t(lang, Key::Min)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn russian_pluralization_covers_all_cases() {
        assert_eq!(tracks_label(Lang::Ru, Some(0)), "0 треков");
        assert_eq!(tracks_label(Lang::Ru, Some(1)), "1 трек");
        assert_eq!(tracks_label(Lang::Ru, Some(2)), "2 трека");
        assert_eq!(tracks_label(Lang::Ru, Some(11)), "11 треков");
        assert_eq!(tracks_label(Lang::Ru, Some(21)), "21 трек");
        assert_eq!(tracks_label(Lang::Ru, Some(23)), "23 трека");
        assert_eq!(tracks_label(Lang::En, Some(1)), "1 track");
        assert_eq!(tracks_label(Lang::En, Some(2)), "2 tracks");
    }

    #[test]
    fn formatting_and_duration_work() {
        assert_eq!(
            tf(Lang::Ru, Key::ImportMatching, &[("done", "3"), ("total", "12")]),
            "Подбираем треки 3 из 12"
        );
        assert_eq!(dur_label(Lang::En, 180.0), "3 min");
        assert_eq!(dur_label(Lang::Ru, 5400.0), "1 ч 30 мин");
    }
}
