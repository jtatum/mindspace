import type { Settings } from '../shared/types';

export function RunLimits({ settings }: { settings: Settings }) {
  const limits = [
    { label: 'Turn timeout', value: settings.turnTimeoutMs, text: `${settings.turnTimeoutMs / 1000} seconds` },
    { label: 'Round limit', value: settings.maxRounds, text: settings.maxRounds.toLocaleString() },
    { label: 'Turn limit', value: settings.maxTurns, text: settings.maxTurns.toLocaleString() },
    { label: 'Token budget', value: settings.maxTokens, text: settings.maxTokens.toLocaleString() },
    { label: 'Session time limit', value: settings.maxDurationMs, text: `${settings.maxDurationMs / 60000} minutes` },
  ].filter(limit => limit.value > 0);
  return limits.length ? <>{limits.map(limit => <div key={limit.label}><dt>{limit.label}</dt><dd>{limit.text}</dd></div>)}</> : <div><dt>Run limits</dt><dd>None</dd></div>;
}
