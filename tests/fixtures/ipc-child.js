// A stand-in for the gateway process in launcher tests. Argument: 'graceful' acts on the
// shutdown message; 'stubborn' ignores it.
const mode = process.argv[2];
process.on('message', (message) => {
    if (mode === 'graceful' && message && message.type === 'gateway.shutdown') {
        process.send({ type: 'test.acknowledged' }, () => process.exit(0));
    }
});
process.send({ type: 'test.ready' });
setInterval(() => {}, 1000);
