export function integrationOptions(enabled: boolean, enabledLabel: string, disabledLabel: string) {
  return [
    { value: 'on' as const, label: enabledLabel, ...(enabled ? { icon: 'check' as const } : {}) },
    { value: 'off' as const, label: disabledLabel, ...(!enabled ? { icon: 'check' as const } : {}) },
  ];
}
