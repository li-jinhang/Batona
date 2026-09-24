import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import webpush from 'web-push';

const configArg = process.argv[2];
const keyDirectoryArg = process.argv[3];
const subjectArg = process.argv[4] ?? process.env.VAPID_SUBJECT;
if (!configArg || !keyDirectoryArg || !subjectArg) throw new Error('Usage: node scripts/init-web-push.mjs <config.json> <protected-key-directory> <https-or-mailto-subject>');
if (!/^https:\/\//.test(subjectArg) && !/^mailto:[^\s@]+@[^\s@]+$/.test(subjectArg)) throw new Error('VAPID subject must be an HTTPS URL or mailto address');

const configPath = resolve(configArg);
const keyDirectory = resolve(keyDirectoryArg);
mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
chmodSync(keyDirectory, 0o700);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
function protectedFile(path, fallback) {
  const absolutePath = resolve(keyDirectory, path ?? fallback);
  const fromRoot = relative(keyDirectory, absolutePath);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error('VAPID key files must stay inside the protected key directory.');
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(absolutePath), 0o700);
  return absolutePath;
}
const publicKeyFile = protectedFile(config.webPush?.publicKeyFile, 'web-push-public.key');
const privateKeyFile = protectedFile(config.webPush?.privateKeyFile, 'web-push-private.key');
const publicExists = existsSync(publicKeyFile), privateExists = existsSync(privateKeyFile);
if (publicExists !== privateExists) throw new Error('Only one VAPID key exists; restore the matching key before continuing.');

if (!publicExists) {
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(publicKeyFile, `${keys.publicKey}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(privateKeyFile, `${keys.privateKey}\n`, { flag: 'wx', mode: 0o600 });
} else {
  const publicKey = readFileSync(publicKeyFile, 'utf8').trim();
  const privateKey = readFileSync(privateKeyFile, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,80}$/.test(privateKey)) throw new Error('Invalid protected VAPID key files; refusing to replace them.');
}
chmodSync(publicKeyFile, 0o600);
chmodSync(privateKeyFile, 0o600);

config.webPush = { subject: subjectArg, publicKeyFile, privateKeyFile };
try { copyFileSync(configPath, `${configPath}.before-web-push`, constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const configTemp = `${configPath}.tmp`;
writeFileSync(configTemp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
renameSync(configTemp, configPath);
console.log('Web Push VAPID keys are configured. Key values were not printed; preserve the protected private key with the encrypted account vault.');
