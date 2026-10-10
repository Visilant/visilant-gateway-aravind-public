// DCMTK binaries. Blank means "resolve on PATH"; the Windows package ships its own
// copies and points these at them.
export const BIN = {
    magick: process.env.MAGICK_BIN || 'magick',
    echoscu: process.env.ECHOSCU_BIN || 'echoscu',
    findscu: process.env.FINDSCU_BIN || 'findscu',
    storescu: process.env.STORESCU_BIN || 'storescu',
    img2dcm: process.env.IMG2DCM_BIN || 'img2dcm',
    dcm2json: process.env.DCM2JSON_BIN || 'dcm2json',
    dcmdump: process.env.DCMDUMP_BIN || 'dcmdump',
    dcmodify: process.env.DCMODIFY_BIN || 'dcmodify',
};

// C-ECHO is a reachability probe behind GET /health, so it fails fast — an operator
// checking a box whose PACS is down should get an answer in seconds, not wait out a
// transfer-length timeout.
export const ECHO_TIMEOUT_MS = 5_000;
export const NETWORK_TIMEOUT_MS = 30_000;
export const LOCAL_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
