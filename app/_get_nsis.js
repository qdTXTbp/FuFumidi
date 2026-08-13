const { NSIS_PATH } = require('app-builder-lib/out/targets/nsis/nsisUtil');
NSIS_PATH().then(p => console.log('NSIS_PATH=' + p)).catch(e => { console.error('ERR', e); process.exit(1); });
