import { IsBoolean } from 'class-validator';
import type { SpanRow } from '../../infrastructure/diagnostics/summary';

export class RecordingDto { @IsBoolean() enabled!: boolean; }
export interface RecordingStatus { enabled: boolean; locked_by: 'env' | null; directory: string }
export interface SegmentDto { id: string; status: string; started_at: string | null; updated_at: string | null; bytes: number; dropped_events: number; node: string | null; active: boolean }
export interface EventCountDto { name: string; count: number }
export interface CaptureRefDto { id: string; status: string; sent_at: string | null }
export interface RunSummaryDto { run_id: string; acknowledged: number; pending: number; captures: CaptureRefDto[] }
export interface SegmentDetailDto { segment: SegmentDto; spans: SpanRow[]; events: EventCountDto[]; runs: RunSummaryDto[]; malformed_lines: number }
export interface RunDetailDto { run_id: string; segments: string[]; spans: SpanRow[]; events: EventCountDto[]; acknowledged: number; pending: number; captures: CaptureRefDto[] }
