// A separate lock owner whose stdin read handle stays alive until every writer
// (launcher and inherited build commands) closes. No PID files or timeouts.
import net from 'node:net';
const endpoint = process.argv[2];
if (!endpoint) throw new Error('Missing lock endpoint');
const server = net.createServer(socket => socket.destroy());
let listening = false;
let closing = false;
const close = () => {
  closing = true;
  if (listening) server.close();
};
process.stdin.on('end', close);
process.stdin.on('error', close);
process.stdin.resume();
server.once('error', error => {
  process.stdout.end(JSON.stringify({ error: error.code ?? error.message }) + '\n');
  process.exitCode = 1;
  process.stdin.destroy();
});
server.listen(endpoint, () => {
  listening = true;
  process.stdout.end(JSON.stringify({ ready: true }) + '\n');
  if (closing) server.close();
});
