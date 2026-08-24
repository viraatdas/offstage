// Prints ~1MB and exits 0. Used to prove that a log sink which cannot keep up
// with the output never changes the verdict: on a fast disk this passes in well
// under a second, so any run that reports anything other than `passed` is
// reporting on the disk rather than on the code under test.
//
// 1MB is far more than the 64KB a pipe will hold, so a sink that stops reading
// leaves the rest stranded, which is the situation under test.
//
// Exits by running off the end rather than calling process.exit(), which would
// discard whatever stdout had not yet flushed to the pipe.
const line = 'y'.repeat(1000);
for (let i = 0; i < 1000; i++) console.log(`${i} ${line}`);
console.log('NOISY FIXTURE PASSED');
