// Wire contract for the optional AI result the capture app sends with a white-light
// photo. The app validates the same shape; change both together. See docs/dicom-output.md.
export type AiTask = { label: string; confidence: number; probabilities: Record<string, number> };
export type AiAssessment = {
  schemaVersion: 1;
  status: 'ready' | 'unavailable';
  reason?: 'eye_not_detected';
  modelRevision: string;
  modelManifestSha256: string;
  assessedAt: string;
  elapsedMs?: number;
  cornea?: AiTask;
  lens?: AiTask;
  pterygium?: AiTask & { positive: boolean; positiveThreshold: number };
};
const LABELS = {
  cornea: ['normal', 'active_infection', 'scar'],
  lens: ['clear', 'immature', 'mature', 'pciol', 'abstain'],
  pterygium: ['negative', 'positive'],
};
const unit = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
function taskValid(value: unknown, labels: string[], binary = false): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  const allowed = ['label', 'confidence', 'probabilities', ...(binary ? ['positive', 'positiveThreshold'] : [])];
  if (Object.keys(t).some(k => !allowed.includes(k)) || !labels.includes(t.label as string) || !unit(t.confidence)) return false;
  if (!t.probabilities || typeof t.probabilities !== 'object' || Array.isArray(t.probabilities)) return false;
  const p = t.probabilities as Record<string, unknown>;
  if (Object.keys(p).length !== labels.length || labels.some(k => !unit(p[k]))) return false;
  if (Math.abs(labels.reduce((n, k) => n + (p[k] as number), 0) - 1) > 0.001) return false;
  if (Math.abs((p[t.label as string] as number) - t.confidence) > 0.00001) return false;
  if (binary) {
    if (!unit(t.positiveThreshold) || typeof t.positive !== 'boolean') return false;
    if (t.positive !== ((p.positive as number) >= t.positiveThreshold)) return false;
    if (t.label !== (t.positive ? 'positive' : 'negative')) return false;
  } else if (labels.some(k => (p[k] as number) > (t.confidence as number) + 0.00001)) return false;
  return true;
}
export function isAiAssessment(value: unknown): value is AiAssessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const allowed = ['schemaVersion', 'status', 'reason', 'modelRevision', 'modelManifestSha256', 'assessedAt', 'elapsedMs', 'cornea', 'lens', 'pterygium'];
  if (Object.keys(a).some(k => !allowed.includes(k)) || a.schemaVersion !== 1) return false;
  if (typeof a.modelRevision !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(a.modelRevision)) return false;
  if (typeof a.modelManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.modelManifestSha256)) return false;
  if (typeof a.assessedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(a.assessedAt) || !Number.isFinite(Date.parse(a.assessedAt)) || new Date(a.assessedAt).toISOString() !== a.assessedAt) return false;
  if (a.reason !== undefined && (a.status !== 'unavailable' || a.reason !== 'eye_not_detected')) return false;
  if (a.status === 'unavailable') return ['elapsedMs', 'cornea', 'lens', 'pterygium'].every(k => a[k] === undefined);
  if (a.status !== 'ready' || typeof a.elapsedMs !== 'number' || !Number.isFinite(a.elapsedMs) || a.elapsedMs < 0) return false;
  return taskValid(a.cornea, LABELS.cornea) && taskValid(a.lens, LABELS.lens) && taskValid(a.pterygium, LABELS.pterygium, true);
}
