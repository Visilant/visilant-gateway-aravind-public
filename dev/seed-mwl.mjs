#!/usr/bin/env node
// Seeds scheduled procedure steps into the local dcm4chee worklist so the gateway has
// something to C-FIND against.
//
//   node dev/seed-mwl.mjs [count]
//   PROCEDURE_ID=ASI01 node dev/seed-mwl.mjs 3   # match mwl.requested_procedure_id
//
// Note the AE: worklist items live on the WORKLIST AE, not DCM4CHEE. The archive and
// the worklist source are different application entities even on one host — which is
// exactly why config models `mwl` and `store` separately.

const BASE = process.env.PACS_BASE ?? 'http://localhost:8008/dcm4chee-arc';
const AE = process.env.MWL_AE ?? 'WORKLIST';
// Matches config mwl.requested_procedure_id. Unset gives each item its own ID, which an
// unfiltered gateway lists and a filtered one does not.
const PROCEDURE_ID = process.env.PROCEDURE_ID;
const count = Number(process.argv[2] ?? 3);

const PATIENTS = [
    { name: 'RAMACHANDRAN^LAKSHMI', id: 'MRN100234', dob: '19580412', sex: 'F', procedure: 'Fundus Photography' },
    { name: 'SUBRAMANIAN^ARJUN', id: 'MRN100587', dob: '19710903', sex: 'M', procedure: 'Anterior Segment Imaging' },
    { name: 'DEVI^MEENAKSHI', id: 'MRN100991', dob: '19640127', sex: 'F', procedure: 'Diabetic Retinopathy Screening' },
    { name: 'KRISHNAN^VIJAY', id: 'MRN101044', dob: '19830715', sex: 'M', procedure: 'Fundus Photography' },
    { name: 'PILLAI^ANJALI', id: 'MRN101202', dob: '19920228', sex: 'F', procedure: 'Cataract Assessment' },
];

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

// Study Instance UID is assigned by the RIS here, which is the case the gateway must
// honour: it uses the worklist's UID rather than minting one, or images land in a
// different study from the ordered one.
const uid = (i) => `1.2.826.0.1.3680043.10.1338.99.${today}.${100 + i}`;

function item(i) {
    const p = PATIENTS[i % PATIENTS.length];
    const suffix = i >= PATIENTS.length ? `${Math.floor(i / PATIENTS.length)}` : '';
    return {
        '00080050': { vr: 'SH', Value: [`ACC${today}${pad(i + 1)}`] },
        '00080090': { vr: 'PN', Value: [{ Alphabetic: 'NATARAJAN^SURESH' }] },
        '00100010': { vr: 'PN', Value: [{ Alphabetic: p.name }] },
        '00100020': { vr: 'LO', Value: [`${p.id}${suffix}`] },
        '00100030': { vr: 'DA', Value: [p.dob] },
        '00100040': { vr: 'CS', Value: [p.sex] },
        '0020000D': { vr: 'UI', Value: [uid(i)] },
        '00321060': { vr: 'LO', Value: [p.procedure] },
        '00401001': { vr: 'SH', Value: [PROCEDURE_ID ?? `RP${today}${pad(i + 1)}`] },
        '00400100': {
            vr: 'SQ',
            Value: [{
                '00080060': { vr: 'CS', Value: ['OP'] },                       // Ophthalmic Photography
                '00400001': { vr: 'AE', Value: ['VISILANT'] },                 // scheduled station AE
                '00400002': { vr: 'DA', Value: [today] },
                '00400003': { vr: 'TM', Value: [`${pad(9 + (i % 8))}3000`] },
                '00400006': { vr: 'PN', Value: [{ Alphabetic: 'NATARAJAN^SURESH' }] },
                '00400007': { vr: 'LO', Value: [p.procedure] },
                '00400009': { vr: 'SH', Value: [`SPS${today}${pad(i + 1)}`] },
                '00400020': { vr: 'CS', Value: ['SCHEDULED'] },
            }],
        },
    };
}

// dcm4chee will not accept a worklist item for a patient it does not know, so the
// patient record is created first. A real RIS has already done this.
function patient(item) {
    return {
        '00100010': item['00100010'],
        '00100020': item['00100020'],
        '00100030': item['00100030'],
        '00100040': item['00100040'],
    };
}

const patientUrl = `${BASE}/aets/DCM4CHEE/rs/patients`;
const url = `${BASE}/aets/${AE}/rs/mwlitems`;
let ok = 0;
for (let i = 0; i < count; i++) {
    const body = item(i);

    const created = await fetch(patientUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dicom+json' },
        body: JSON.stringify(patient(body)),
    });
    if (!created.ok) {
        console.error(`  patient ${i + 1} failed: HTTP ${created.status} ${await created.text()}`);
        continue;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dicom+json' },
        body: JSON.stringify(body),
    });
    if (res.ok) {
        ok++;
    } else {
        console.error(`  item ${i + 1} failed: HTTP ${res.status} ${await res.text()}`);
    }
}
console.log(`seeded ${ok}/${count} worklist items on ${AE} for ${today}`);
