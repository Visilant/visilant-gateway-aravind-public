// Allowlist sanitizer for telemetry pushed by capture phones. Everything a phone sends
// passes through here before it touches disk: unknown keys are dropped, values must be
// booleans, null, finite numbers or short safe tokens, and crash text is stripped of
// anything that could carry patient identity (names, MRNs, accession numbers, paths).
//
// Kept free of imports from the rest of src/ so it can be unit tested in isolation.

export type PhoneAttributeValue = string | number | boolean | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_.:/-]{1,64}$/;

// Hardware, network and queue keys shared with the gateway recorder's vocabulary.
const BASE_KEYS = [
    'stage', 'model', 'threads', 'delegate', 'width', 'height', 'bytes', 'count', 'status', 'error_code', 'late',
    'queue_wait_ms', 'request_id', 'operation_id', 'method', 'route', 'frame_gap_ms', 'result_age_ms', 'processed_fps',
    'duration_sum_ms', 'duration_min_ms', 'duration_max_ms', 'duration_p50_ms', 'duration_p95_ms', 'duration_p99_ms',
    'window_ms', 'skipped', 'foreground', 'charging', 'battery_level', 'battery_temperature_c', 'battery_voltage_mv',
    'battery_current_ua', 'battery_charge_uah', 'thermal_status', 'thermal_headroom', 'power_save', 'cpu_percent',
    'rss_bytes', 'pss_bytes', 'java_heap_used_bytes', 'java_heap_max_bytes', 'native_heap_bytes', 'available_memory_bytes',
    'low_memory', 'heartbeat_delay_ms', 'pending', 'failed', 'otherGateway', 'attempt', 'elapsed_ms', 'connection',
    'marker', 'dropped_events', 'pressure_level',
];
const SEEKER_KEYS = ['seeker_reason', 'seeker_generation', 'lights_lost', 'light_mode', 'firmware_version', 'ping_supported', 'dev_bypass'];
const NETWORK_KEYS = ['network_kind', 'wifi_connected', 'internet_reachable', 'offline_duration_ms'];
const CAPTURE_KEYS = [
    'screening_id', 'capture_id', 'laterality', 'light', 'verified_white', 'trigger', 'shot_count', 'selected_index',
    'suggested_index', 'operator_overrode_suggested', 'step_action', 'wake_reason',
];
const DETECTOR_KEYS = [
    'eye_detected', 'iris_detected', 'capture_ready', 'distance_status', 'centering_status', 'gaze_status', 'eye_confidence',
    'iris_confidence', 'pupil_confidence', 'eye_width_ratio', 'quality_score', 'quality_score_max', 'quality_score_min',
    'sharpness_roi', 'hold_ms', 'align_duration_ms',
];
const MODEL_KEYS = [
    'eye_gate_passed', 'assessment_status', 'assessment_reason',
    'cornea_label', 'cornea_confidence', 'cornea_entropy', 'lens_label', 'lens_confidence', 'lens_entropy',
    'pterygium_label', 'pterygium_confidence', 'pterygium_entropy', 'pterygium_positive', 'pterygium_threshold',
];

export const PHONE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([...BASE_KEYS, ...SEEKER_KEYS, ...NETWORK_KEYS, ...CAPTURE_KEYS, ...DETECTOR_KEYS, ...MODEL_KEYS]);

// Keys whose documented values form a closed set. Anything else is dropped, so a free
// text value can never slip through under a key that is meant to be an enum.
const ENUMS: Record<string, ReadonlySet<string>> = {
    seeker_reason: new Set(['detached', 'heartbeat_timeout', 'write_failed', 'read_error', 'stale_device', 'permission_denied']),
    light_mode: new Set(['white', 'slit', 'blue', 'off']),
    network_kind: new Set(['wifi', 'cellular', 'none', 'other']),
    laterality: new Set(['L', 'R']),
    light: new Set(['WHITE', 'SLIT', 'BLUE']),
    trigger: new Set(['auto', 'manual']),
    step_action: new Set(['skip', 'replace', 'remove', 'discard']),
    sharpness_roi: new Set(['iris', 'eye', 'center']),
    assessment_status: new Set(['ready', 'unavailable']),
    assessment_reason: new Set(['eye_not_detected', 'assessment_timeout', 'assessment_failed']),
};
// Correlation references must be UUIDs; they are the only way events join up.
const UUID_KEYS = new Set(['screening_id', 'capture_id', 'operation_id', 'request_id']);

export function safePhoneAttributes(input: Record<string, unknown> | null | undefined): Record<string, PhoneAttributeValue> {
    const out: Record<string, PhoneAttributeValue> = {};
    if (!input || typeof input !== 'object') return out;
    for (const [key, value] of Object.entries(input)) {
        if (!PHONE_ATTRIBUTE_KEYS.has(key)) continue;
        if (value === null) { out[key] = null; continue; }
        const allowed = ENUMS[key];
        if (allowed) { if (typeof value === 'string' && allowed.has(value)) out[key] = value; continue; }
        if (UUID_KEYS.has(key)) { if (typeof value === 'string' && UUID.test(value)) out[key] = value.toLowerCase(); continue; }
        if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
        else if (typeof value === 'string' && TOKEN.test(value)) out[key] = value;
    }
    return out;
}

const REDACTED = '[redacted]';
const NON_ASCII = /[^\x20-\x7E]+/g;
const URL_LIKE = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s()]+/g;
const ABSOLUTE_PATH = /(^|[\s(@])(\/[^\s()]+)/g;
const QUERY = /\?[^\s():]*/g;

// A path or URL reduced to its last two segments: enough to find the module, never the
// app's private storage layout or a capture file named after a patient's folder.
function shortPath(value: string): string {
    const parts = value.replace(QUERY, '').replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
}

/** Short non-PHI crash summary: identity references, names, paths and non-ASCII text removed. */
export function sanitizeCrashMessage(message: string): string {
    let text = String(message ?? '').replace(/[\t\r\n]+/g, ' ').replace(NON_ASCII, REDACTED);
    text = text.replace(URL_LIKE, match => shortPath(match));
    text = text.replace(ABSOLUTE_PATH, (_match, lead: string, path: string) => lead + shortPath(path));
    text = text.replace(/\S*\^\S*/g, REDACTED);
    // Everything after a patient/accession/MRN reference may be the value itself.
    const identity = /patient|accession|mrn/i.exec(text);
    if (identity) text = text.slice(0, identity.index) + REDACTED;
    return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** One stack frame reduced to module/file:line, or null when it cannot be made safe. */
export function sanitizeStackFrame(frame: string): string | null {
    let text = String(frame ?? '').replace(/\t/g, ' ').trim();
    if (!text || /[^\x20-\x7E]/.test(text) || text.includes('^')) return null;
    text = text.replace(QUERY, '');
    text = text.replace(URL_LIKE, match => shortPath(match));
    text = text.replace(ABSOLUTE_PATH, (_match, lead: string, path: string) => lead + shortPath(path));
    // Frames never legitimately carry key=value pairs or an identity label followed by a value.
    if (/[=&]/.test(text) || /(patient|accession|mrn)\w*\s*[=:]/i.test(text)) return null;
    return text.slice(0, 200) || null;
}

export function sanitizeStack(frames: readonly string[] | null | undefined): string[] {
    const out: string[] = [];
    for (const frame of frames ?? []) {
        if (out.length >= 40) break;
        const safe = sanitizeStackFrame(frame);
        if (safe) out.push(safe);
    }
    return out;
}
