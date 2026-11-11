import { randomUUID } from 'crypto';
import { safePhoneAttributes, sanitizeCrashMessage, sanitizeStack, sanitizeStackFrame } from '../src/infrastructure/diagnostics/phoneAttributes';

describe('safePhoneAttributes', () => {
    it('keeps allowlisted Seeker, Wi-Fi, battery, capture, detector and CNN keys with safe values', () => {
        const screening = randomUUID(), capture = randomUUID();
        const input = {
            // Seeker
            seeker_reason: 'heartbeat_timeout', seeker_generation: 3, lights_lost: true, light_mode: 'slit', firmware_version: '1.4.2', ping_supported: false, dev_bypass: null,
            // Wi-Fi / network
            network_kind: 'wifi', wifi_connected: false, internet_reachable: false, offline_duration_ms: 12500,
            // Battery / resources
            battery_level: 41, battery_temperature_c: 38.5, charging: true, thermal_status: 2, cpu_percent: 12.5, pss_bytes: 1024,
            // Capture & screening
            screening_id: screening, capture_id: capture, laterality: 'L', light: 'WHITE', verified_white: true, trigger: 'auto', shot_count: 5,
            selected_index: 2, suggested_index: 1, operator_overrode_suggested: true, step_action: 'replace', wake_reason: 'motion',
            // Detector
            eye_detected: true, iris_detected: true, capture_ready: true, distance_status: 'ok', centering_status: 'too_left', gaze_status: 'ok',
            eye_confidence: 0.91, iris_confidence: 0.88, pupil_confidence: 0.5, eye_width_ratio: 0.33, quality_score: 120.4, quality_score_max: 140,
            quality_score_min: 99, sharpness_roi: 'iris', hold_ms: 800, align_duration_ms: 2300,
            // CNN
            eye_gate_passed: true, assessment_status: 'ready', assessment_reason: 'assessment_timeout',
            cornea_label: 'normal', cornea_confidence: 0.97, cornea_entropy: 0.12, lens_label: 'immature', lens_confidence: 0.71, lens_entropy: 0.8,
            pterygium_label: 'negative', pterygium_confidence: 0.9, pterygium_entropy: 0.3, pterygium_positive: false, pterygium_threshold: 0.5,
        };
        expect(safePhoneAttributes(input)).toEqual({ ...input, screening_id: screening.toLowerCase(), capture_id: capture.toLowerCase() });
    });

    it('keeps the pre-existing hardware, network and queue keys', () => {
        const input = { stage: 'warm', model: 'yolo11n', threads: 4, delegate: 'gpu', duration_p95_ms: 22.1, java_heap_used_bytes: 9, heartbeat_delay_ms: 3, otherGateway: false, pressure_level: 'moderate', dropped_events: 0 };
        expect(safePhoneAttributes(input)).toEqual(input);
    });

    it('strips unknown keys, names, spaces, long strings, non-finite numbers and nested values', () => {
        expect(safePhoneAttributes({
            patient_id: 'MRN123', patient_name: 'DOE^JOHN', accession_number: 'A1', birth_date: '19800101',
            stage: 'DOE^JOHN', model: 'John Doe', route: 'x'.repeat(65), count: Infinity, bytes: Number.NaN,
            status: { nested: true }, error_code: ['a'], width: 640,
        })).toEqual({ width: 640 });
    });

    it('drops enumerated keys whose value is outside the documented set, and malformed ids', () => {
        expect(safePhoneAttributes({
            seeker_reason: 'RAJESH', light_mode: 'uv', network_kind: 'satellite', laterality: 'both', light: 'white', trigger: 'voice',
            step_action: 'delete', sharpness_roi: 'face', assessment_status: 'maybe', assessment_reason: 'other', screening_id: 'not-a-uuid',
            capture_id: '../../x', seeker_generation: 2,
        })).toEqual({ seeker_generation: 2 });
    });

    it('ignores prototype keys', () => {
        const input = JSON.parse('{"__proto__": {"count": 1}, "constructor": 1, "count": 2}');
        expect(safePhoneAttributes(input)).toEqual({ count: 2 });
    });
});

describe('crash sanitizer', () => {
    it('redacts everything after a patient or accession reference in the message', () => {
        expect(sanitizeCrashMessage('Cannot read property of undefined while saving patient DOE JOHN 123')).toBe('Cannot read property of undefined while saving [redacted]');
        expect(sanitizeCrashMessage('Accession A123 mismatch')).toBe('[redacted]');
        expect(sanitizeCrashMessage('Bad mrn=12345')).toBe('Bad [redacted]');
    });

    it('removes DICOM person names, non-ASCII text and absolute device paths from messages', () => {
        expect(sanitizeCrashMessage('Name DOE^JOHN rejected')).toBe('Name [redacted] rejected');
        expect(sanitizeCrashMessage('Lookup failed for ராஜேஷ் now')).toBe('Lookup failed for [redacted] now');
        expect(sanitizeCrashMessage('ENOENT file:///data/user/0/org.visilant/files/captures/abc.jpg')).toBe('ENOENT captures/abc.jpg');
        expect(sanitizeCrashMessage('ENOENT /storage/emulated/0/Pictures/x/y.jpg')).toBe('ENOENT x/y.jpg');
        expect(sanitizeCrashMessage('x'.repeat(500))).toHaveLength(240);
    });

    it('keeps relative module frames and reduces file paths to the last two segments', () => {
        expect(sanitizeStackFrame('at CaptureScreen (file:///data/user/0/org.visilant/files/bundle/src/screens/CaptureScreen.js:120:14)'))
            .toBe('at CaptureScreen (screens/CaptureScreen.js:120:14)');
        expect(sanitizeStackFrame('at org.visilant.seeker.SeekerModule.write(SeekerModule.kt:88)')).toBe('at org.visilant.seeker.SeekerModule.write(SeekerModule.kt:88)');
        expect(sanitizeStackFrame('render@index.android.bundle:1:2345')).toBe('render@index.android.bundle:1:2345');
        // Screen and module names that merely contain the word stay useful.
        expect(sanitizeStackFrame('at PatientListScreen (screens/PatientList.js:12:3)')).toBe('at PatientListScreen (screens/PatientList.js:12:3)');
    });

    it('strips query strings but keeps the frame', () => {
        expect(sanitizeStackFrame('at foo (http://localhost:8081/index.bundle?platform=android&dev=true:12:34)')).toBe('at foo (localhost:8081/index.bundle:12:34)');
    });

    it('drops frames carrying person names, patient references or non-ASCII text', () => {
        expect(sanitizeStackFrame('at save (DOE^JOHN.js:1)')).toBeNull();
        expect(sanitizeStackFrame('at savePatient name=Ravi')).toBeNull();
        expect(sanitizeStackFrame('at lookup accession: A123')).toBeNull();
        expect(sanitizeStackFrame('at load patient_id:MRN1 (x.js:1:1)')).toBeNull();
        expect(sanitizeStackFrame('at ராஜேஷ் (x.js:1:1)')).toBeNull();
        expect(sanitizeStackFrame('   ')).toBeNull();
    });

    it('sanitizes a whole stack, capping it at 40 frames of 200 characters', () => {
        const stack = sanitizeStack(['at a (file:///data/app/x/y/z.js:1:1)', 'at DOE^JOHN', ...Array.from({ length: 60 }, (_, i) => `at f${i} (m.js:${i})` + 'x'.repeat(300))]);
        expect(stack[0]).toBe('at a (y/z.js:1:1)');
        expect(stack).toHaveLength(40);
        for (const frame of stack) expect(frame.length).toBeLessThanOrEqual(200);
    });
});
