// Prints one line, then hangs. Used to prove that `timeoutMs` produces
// `status: 'errored'` (not 'failed') and that output captured before the kill
// still reaches command.log.
console.log('slow fixture started');
setInterval(() => {}, 1000);
