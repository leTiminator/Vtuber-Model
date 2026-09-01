/**
 * Serve the app to a phone on the same Wi-Fi.
 *
 *   npm run phone
 *
 * Two things make this different from `npm run dev`. The server has to listen
 * on the LAN rather than on loopback, and it has to speak HTTPS: browsers only
 * hand out the camera on a secure origin, and "localhost" stops counting as one
 * the moment the address is an IP. So this run uses a self-signed certificate,
 * which is why the phone asks whether you trust it. You do — it is your own
 * machine, and the certificate was generated on it a moment ago.
 */
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';

const PORT = 5173;

/** Every IPv4 address this machine has on a real network. */
function addresses() {
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      found.push({ name, address: net.address });
    }
  }
  // Ordinary home networks first; virtual adapters (Docker, VMs, VPNs) are
  // rarely the one the phone can see, and listing them first misleads.
  const homely = ({ address }) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return found.sort((a, b) => Number(homely(b)) - Number(homely(a)));
}

const nets = addresses();

console.log();
if (!nets.length) {
  console.log('  This machine has no network address other than loopback.');
  console.log('  Connect it to the same Wi-Fi as the phone and try again.');
  console.log();
} else {
  console.log('  On your phone, open one of these — same Wi-Fi as this computer:');
  console.log();
  for (const net of nets) {
    console.log(`      https://${net.address}:${PORT}      (${net.name})`);
  }
  console.log();
  console.log('  The phone will warn that the certificate is not trusted.');
  console.log('  That is expected: it is a certificate this machine just made');
  console.log('  for itself. Tap Advanced, then continue to the site.');
  console.log();
  console.log('    Safari:  Show Details  ->  visit this website');
  console.log('    Chrome:  Advanced      ->  Proceed to ...');
  console.log();
  console.log('  Then press "Start camera" and allow the camera when asked.');
  console.log();
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['run', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, VTUBER_PHONE: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
