import 'reflect-metadata';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { isAiAssessment, type AiAssessment } from '../src/domain/assessment';
import { CreateCaptureDto } from '../src/application/dto/capture.dto';
import { parseMultipartDto } from '../src/presentation/validation';
import { DicomBuilder } from '../src/infrastructure/dicom/DicomBuilder';
const assessment: AiAssessment = { schemaVersion: 1, status: 'unavailable', modelRevision: 'models-v1', modelManifestSha256: 'a'.repeat(64), assessedAt: '2026-10-08T12:00:00.000Z' };
const entry = { accession_number: 'SYNTHETIC001', study_instance_uid: '1.2.3', patient_id: 'SYNTHETIC' };
const body = { worklist_entry: JSON.stringify(entry), laterality: 'R', light: 'WHITE', ai_assessment: JSON.stringify(assessment) };
test('strict multipart contract accepts white metadata and rejects all other modes', () => {
 expect(parseMultipartDto(CreateCaptureDto, body, ['worklist_entry','ai_assessment']).ai_assessment).toEqual(assessment);
 for (const light of ['BLUE','SLIT',undefined]) expect(() => parseMultipartDto(CreateCaptureDto, {...body,light}, ['worklist_entry','ai_assessment'])).toThrow('validation');
 for (const ai_assessment of ['null', '{', JSON.stringify({...assessment,patient_name:'forbidden'}), JSON.stringify({...assessment,status:'ready'})]) {
  expect(() => parseMultipartDto(CreateCaptureDto,{...body,ai_assessment},['worklist_entry','ai_assessment'])).toThrow();
 }
});
test.each([
 [assessment, true],
 [{ ...assessment, reason: 'eye_not_detected' }, true],
 [{ ...assessment, reason: 'unknown' }, false],
 [{ ...assessment, reason: 'eye_not_detected', elapsedMs: 10 }, false],
 [{ ...assessment, reason: 'eye_not_detected', cornea: {} }, false],
 [{ ...assessment, status: 'ready', reason: 'eye_not_detected' }, false],
 [{ ...assessment, status: 'ready' }, false],
 [{ ...assessment, patient_name: 'forbidden' }, false],
 [{ ...assessment, schemaVersion: 2 }, false],
 [null, false],
])('the gateway validates the assessment payload: %j', (value, valid) => {
 expect(isAiAssessment(value)).toBe(valid);
});
test('missing-eye reason is accepted at the upload boundary but rejected on a ready result', () => {
 const noEye = { ...assessment, reason: 'eye_not_detected' };
 expect(parseMultipartDto(CreateCaptureDto, { ...body, ai_assessment: JSON.stringify(noEye) }, ['worklist_entry', 'ai_assessment']).ai_assessment).toEqual(noEye);
 const ready = { ...assessment, status: 'ready', elapsedMs: 20,
  cornea: { label: 'normal', confidence: 1, probabilities: { normal: 1, active_infection: 0, scar: 0 } },
  lens: { label: 'clear', confidence: 1, probabilities: { clear: 1, immature: 0, mature: 0, pciol: 0, abstain: 0 } },
  pterygium: { label: 'negative', confidence: 1, probabilities: { negative: 1, positive: 0 }, positive: false, positiveThreshold: 0.5 } };
 expect(isAiAssessment(ready)).toBe(true);
 expect(isAiAssessment({ ...ready, reason: 'eye_not_detected' })).toBe(false);
});
test('DICOM boundary rejects non-white metadata before opening the image', async () => {
 const builder = new DicomBuilder({error:jest.fn(),info:jest.fn()} as never);
 await expect(builder.build('/does/not/exist', {studyInstanceUid:'1.2.3',seriesInstanceUid:'1.2.3.4',sopInstanceUid:'1.2.3.4.5',seriesNumber:1,instanceNumber:1,laterality:'R',captureLight:'BLUE',aiAssessment:assessment}, '/unused')).rejects.toThrow('WHITE');
});
// DCMTK integration stays opt-in on machines that do not have the binaries.
const nativeTest = process.env.TEST_DCMTK === '1' ? test : test.skip;
nativeTest.each([assessment, { ...assessment, reason: 'eye_not_detected' as const }])('private creator and explicit UT survive JPEG conversion and JSON extraction: %j', async (value) => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(),'visilant-ai-test-'));
 try {
  const jpeg = path.join(directory,'image.jpg'), output = path.join(directory,'image.dcm');
  execFileSync('magick',['-size','32x32','xc:white',jpeg]);
  const logger = {error:jest.fn(),info:jest.fn()};
  const builder = new DicomBuilder(logger as never);
  await builder.build(jpeg,{patientId:'SYNTHETIC',studyInstanceUid:'1.2.3',seriesInstanceUid:'1.2.3.4',sopInstanceUid:'1.2.3.4.5',seriesNumber:1,instanceNumber:1,laterality:'R',captureLight:'WHITE',aiAssessment:value},output);
  const dump = execFileSync('dcmdump',['+L','+P','0011,0010','+P','0011,1001','+P','0008,0060','+P','0020,0062',output],{encoding:'utf8'});
  expect(dump).toContain('LO [VISILANT_AI_1]');
  const payload = dump.match(/\(0011,1001\) UT \[(.*)\]/)?.[1];
  expect(JSON.parse(payload!)).toEqual(value);
  expect(dump).toContain('CS [OP]'); expect(dump).toContain('CS [R]');
  expect(logger.error).not.toHaveBeenCalled();
 } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
