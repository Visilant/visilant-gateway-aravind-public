import { v7 as uuidv7 } from 'uuid';

// Made-up phone telemetry, one valid event per type, shaped as the capture app will
// send it. Nothing here is from a site.
export const DEVICE_ID = '7d0c3f0e-1b7a-4c8e-9a51-2f3b4c5d6e7f';
export const SESSION_ID = '3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const CAPTURE_ID = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
export const SCREENING_ID = '9c8b7a6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

export const PAYLOADS: Record<string, { payload: Record<string, unknown>; capture?: boolean }> = {
    'app.started': { payload: { app_version: '2.4.0', android_version: '15', android_sdk: 35, device_model: 'SM-A175F', ai_model_revision: 'cornea-v3.1', ai_model_manifest_sha256: 'a'.repeat(64), yolo_model_revision: 'yolo-eye-7' } },
    'app.crashed': { payload: { source: 'uncaught_handler', app_version: '2.4.0', error_code: 'E_CAMERA', exception_class: 'java.lang.IllegalStateException', exit_reason: 'crash', stack_frames: [{ class: 'org.visilant.capture.CameraController', method: 'open', file: 'CameraController.kt', line: 120 }, { class: 'org.visilant.capture.CameraController$1', method: '<init>', file: 'CameraController.java', line: 9 }] } },
    'operation.failed': { payload: { operation: 'worklist_refresh', error_code: 'HTTP_503' } },
    'capture.taken': { payload: { light: 'WHITE', eye: 'R', mode: 'autocapture' }, capture: true },
    'capture.uploaded': { payload: { duration_ms: 840, bytes: 412_000, http_status: 200 }, capture: true },
    'capture.upload_failed': { payload: { duration_ms: 30_000, bytes: 412_000, error_code: 'NET_TIMEOUT' }, capture: true },
    'yolo.autocapture': { payload: { outcome: 'fired', frames_evaluated: 48, time_to_trigger_ms: 2100, winning_box: { x: 0.31, y: 0.22, width: 0.4, height: 0.38 }, winning_score: 0.93, rejected_frames: { no_eye: 3, clipped: 1, too_far: 9, gaze_off: 2 }, operator_decision: 'kept', yolo_model_revision: 'yolo-eye-7' }, capture: true },
    'device.health': { payload: { battery_pct: 64, charging: false, battery_temp_c: 33.5, thermal_status: 'light', free_storage_bytes: 12_000_000_000, network_kind: 'wifi', wifi_rssi_dbm: -58, seeker_connected: true } },
    'gateway.unreachable': { payload: { from: '2026-11-12T03:10:00.000Z', to: '2026-11-12T03:42:10.000Z', dropped: { 'device.health': 6, 'capture.taken': 1 } } },
};

export function phoneEvent(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const sample = PAYLOADS[type];
    return {
        event_id: uuidv7(), schema_version: 1, type, occurred_at: new Date().toISOString(),
        device_id: DEVICE_ID, session_id: SESSION_ID,
        ...(sample?.capture ? { capture_id: CAPTURE_ID, screening_id: SCREENING_ID } : {}),
        payload: sample ? structuredClone(sample.payload) : {},
        ...overrides,
    };
}
