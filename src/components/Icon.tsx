import type { CSSProperties } from 'react';

/** Single source of truth — the Material Symbols font is subset to exactly these glyphs. */
export const ICONS = [
  'add', 'add_to_queue', 'animation', 'arrow_back', 'auto_awesome', 'bedtime', 'blur_on', 'bolt', 'brightness_auto',
  'check', 'chevron_left', 'chevron_right', 'close', 'close_fullscreen', 'coffee', 'colorize', 'contrast', 'dark_mode',
  'delete', 'download', 'edit', 'error', 'favorite', 'format_paint', 'fullscreen', 'fullscreen_exit', 'graphic_eq', 'history',
  'home', 'image', 'info', 'keyboard', 'layers', 'light_mode', 'local_fire_department', 'lyrics', 'menu', 'menu_open',
  'more_vert', 'music_note', 'nightlife', 'open_in_full', 'palette', 'park', 'pause', 'person', 'piano', 'play_arrow',
  'playlist_add', 'playlist_add_check', 'playlist_remove', 'queue_music', 'queue_play_next', 'refresh', 'repeat',
  'repeat_one', 'right_panel_close', 'right_panel_open', 'rocket_launch', 'search', 'search_off', 'self_improvement',
  'settings', 'shuffle', 'skip_next', 'skip_previous', 'thumb_down', 'translate', 'trending_up', 'tune', 'upload', 'volume_down',
  'volume_off', 'volume_up', 'wallpaper', 'water_drop', 'wifi_off',
] as const;

export type IconName = (typeof ICONS)[number];

export function Icon({ name, fill, size, className, style }: { name: IconName; fill?: boolean; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden="true" className={'icon' + (fill ? ' filled' : '') + (className ? ' ' + className : '')} style={size ? { fontSize: size, ...style } : style}>
      {name}
    </span>
  );
}
