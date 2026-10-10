'use strict';
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '22') {
  throw new Error('This bundle requires Windows x64 and Node 22.');
}
const Database = require(process.argv[2]);
const database = new Database(':memory:');
database.prepare('SELECT 1').get();
database.close();
