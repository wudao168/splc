import { packager } from '@electron/packager';
import { mkdir, copyFile, cp, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, '.data', 'desktop-staging');
await mkdir(staging, {recursive:true});
await copyFile(path.join(root,'package.json'),path.join(staging,'package.json'));
await cp(path.join(root,'desktop'),path.join(staging,'desktop'),{recursive:true});
const manifest = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const paths = await packager({
  dir:staging, out:path.join(root,process.env.CAIDAN_PACKAGE_OUT || 'release'), name:'Caidan', platform:'win32', arch:'x64',
  electronVersion:manifest.devDependencies.electron, electronZipDir:path.join(root,'.data','electron-zip'),
  icon:path.join(root,'desktop','assets','caidan-icon.ico'),
  overwrite:true, asar:true, prune:false, extraResource:[path.join(root,'.data','server-dist','caidan-server')],
  win32metadata:{CompanyName:'Caidan',FileDescription:'采单 · 采购协同',ProductName:'采单客户端'},
});
await promisify(execFile)('icacls', [paths[0], '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T']);
console.log(paths.join('\n'));
