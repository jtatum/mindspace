import type { Activity } from '../shared/types.js';

const readTools = new Set(['read_shared_file', 'read_papers', 'web_fetch']);
const bounded = (value: unknown) => {
  if (value === undefined) return value;
  const text = JSON.stringify(value);
  return text.length <= 4000 ? value : { truncated: true, preview: text.slice(0, 1000) };
};
export function compactActivity(activity: Activity): Activity {
  if (activity.kind !== 'tool') return activity;
  let args = activity.arguments;
  if (['write_shared_file', 'record_paper_review'].includes(activity.title)) {
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = undefined; } }
    if (args && typeof args === 'object') {
      const { text, review, ...metadata } = args as Record<string, unknown>;
      args = { ...metadata, contentOmitted: true, characters: typeof (text ?? review) === 'string' ? String(text ?? review).length : 0 };
    }
  }
  const omitRead = readTools.has(activity.title) && activity.status !== 'failed';
  return { ...activity, arguments: bounded(args), text: omitRead ? '' : activity.text.slice(0, 1000), result: omitRead ? { contentOmitted: true, note: 'Read content is sent to the agent; use shared files to inspect paper text and reviews.' } : bounded(activity.result) };
}

// Compact legacy rows in SQLite before materializing routine snapshots. Original
// source text remains in shared files and model context, not activity history.
export const ACTIVITY_DATA_SQL = `CASE
  WHEN json_extract(data,'$.title') IN ('read_shared_file','read_papers','web_fetch') AND status != 'failed'
    THEN json_set(json_remove(data,'$.result'),'$.text','')
  WHEN json_extract(data,'$.title') IN ('write_shared_file','record_paper_review')
    THEN json_remove(data,'$.arguments')
  ELSE data END`;
