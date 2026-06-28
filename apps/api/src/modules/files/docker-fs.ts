/**
 * In-container filesystem operations via `docker exec` / `docker cp`.
 *
 * Sister to FilesService's host-fs path. Used when the app deploy lives
 * entirely inside a container (marketplace installs, image-only deploys),
 * so the host dir holds only docker-compose.yml + .env and the actual
 * app files (e.g. PrestaShop's `/var/www/html`) are unreachable through
 * the normal bind-mount browser.
 *
 * **Security model.** We rely on shell escaping of every user-supplied
 * path. The container is presumed to be a trust boundary the platform
 * already exposes (logs, terminal, env editor); reading/writing inside
 * it does not escalate privileges beyond what the existing terminal tab
 * grants. We still:
 *
 *   - Quote paths with single-quotes and reject single-quote in input
 *     so the shell never gets a partial argument.
 *   - Reject null bytes, control chars, and absolute paths that exit
 *     the configured workdir (a "browser root" — `/var/www/html` for
 *     PrestaShop, `/usr/share/nginx/html` for Nginx, etc.).
 *   - Cap file sizes for read/write the same way the host-fs side does.
 *
 * **Workdir resolution.** We don't trust the dockerd metadata blindly;
 * instead the caller picks a sensible browser root per image. PrestaShop's
 * Apache servers `/var/www/html`, WordPress same, nginx serves
 * `/usr/share/nginx/html`. Fallback: `/`.
 *
 * **Why not docker SDK.** node-docker-api would be cleaner but adds 4 MB
 * of deps for ~6 calls. execFile of the CLI is already how every other
 * DockControl module talks to docker — keeps the surface uniform.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

export interface DockerFsTarget {
  /** Container name (e.g. `dockcontrol-prestashop-abc123def456`). */
  containerName: string;
  /** Absolute path inside the container that the browser is anchored at. */
  rootDir: string;
}

export interface DockerEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  permissions: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB — mirror host-fs

/**
 * Per-image hints for the most useful "where is the app" path.
 *
 * Match is done against the container's image string lower-cased and
 * stripped of `:tag@digest`. We keep the list narrow; everything else
 * falls back to `/` and the user can browse from root.
 */
const IMAGE_ROOTS: Array<[RegExp, string]> = [
  [/prestashop/, '/var/www/html'],
  [/wordpress/, '/var/www/html'],
  [/ghost/, '/var/lib/ghost/content'],
  [/nextcloud/, '/var/www/html'],
  [/gitea/, '/data'],
  [/nginx/, '/usr/share/nginx/html'],
  [/httpd|apache/, '/usr/local/apache2/htdocs'],
  [/n8n/, '/home/node/.n8n'],
  [/grafana/, '/var/lib/grafana'],
  [/code-server|coder/, '/home/coder'],
];

/**
 * Pick the sensible browser root for an image. Returns `/` when no rule
 * matches — caller can still browse, just from the filesystem root.
 */
export function pickRootForImage(image: string | null | undefined): string {
  if (!image) return '/';
  const lc = image.toLowerCase();
  for (const [re, dir] of IMAGE_ROOTS) {
    if (re.test(lc)) return dir;
  }
  return '/';
}

/**
 * Validate a relative path the browser passed. Rejects null bytes,
 * control chars, absolute paths, `..` segments. Returns the normalized
 * form joined onto rootDir.
 */
function joinAndValidate(rootDir: string, relPath: string): string {
  if (typeof relPath !== 'string') throw new Error('Path must be a string');
  if (relPath.includes('\0')) throw new Error('Null byte in path');
  if (/[\x01-\x1f]/.test(relPath)) throw new Error('Control char in path');
  // Reject single quotes — we wrap the path in single-quotes in the
  // shell command, and there is no portable single-quote escape inside
  // a single-quoted string. Easier to forbid than to leak via
  // injection. UI surfaces are POSIX paths, not arbitrary blobs.
  if (relPath.includes("'")) throw new Error("Single quotes not allowed in paths");
  // Normalize separators, strip leading `/`, refuse `..`.
  const parts = relPath.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new Error('Path traversal denied');
  }
  if (!parts.length) return rootDir;
  return rootDir.replace(/\/+$/, '') + '/' + parts.join('/');
}

/**
 * Run a one-shot command inside the container. We use `sh -c` so we can
 * pass a compound command (`ls -la ... | head -N` etc.) without having
 * to spawn a separate sh ourselves.
 */
/** Thrown when the container image ships no shell (scratch/distroless —
 *  Portainer, many Go binaries). Callers surface a human explanation
 *  instead of a generic exec failure. */
export class NoShellError extends Error {
  constructor(containerName: string) {
    super(
      `Container '${containerName}' has no shell (scratch/distroless image) — web file browsing needs to run \`ls\` inside the container, which this image cannot do. Its data is safe in a docker volume: manage it through the app's own UI, or create an SFTP account for this app (SFTP mounts the volume directly, no shell needed).`,
    );
    this.name = 'NoShellError';
  }
}

/** Thrown when the container doesn't exist (yet) — app still deploying,
 *  stopped+removed, or crashed before creation. */
export class ContainerNotRunningError extends Error {
  constructor(containerName: string, state: 'missing' | 'stopped') {
    super(
      state === 'missing'
        ? `Container '${containerName}' does not exist yet — the app is probably still deploying (image pull + first boot can take a few minutes). Check the app's status and retry once it's RUNNING.`
        : `Container '${containerName}' is stopped — start the app to browse its files.`,
    );
    this.name = 'ContainerNotRunningError';
  }
}

async function dockerSh(
  containerName: string,
  shellCmd: string,
  timeout = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  // execFile guards us from arg-list injection on the host side. The
  // injection-sensitive value lives INSIDE shellCmd which we build
  // with single-quoted paths after `joinAndValidate`.
  try {
    return await execFileAsync('docker', ['exec', containerName, 'sh', '-c', shellCmd], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err: any) {
    const blob = `${err?.stderr || ''} ${err?.message || ''}`.toLowerCase();
    // Container doesn't exist (app mid-deploy / removed) or isn't running
    // — distinct, actionable stories vs "image has no shell".
    if (blob.includes('no such container')) {
      throw new ContainerNotRunningError(containerName, 'missing');
    }
    if (blob.includes('is not running') || blob.includes('container is paused')) {
      throw new ContainerNotRunningError(containerName, 'stopped');
    }
    // Exit codes are the RELIABLE signal — dockerd's error phrasing varies
    // wildly by version (and some builds emit nothing on stderr at all,
    // leaving only "Command failed: …"):
    //   126 = found but not executable / cannot invoke
    //   127 = command not found (no `sh` in the image — scratch/distroless)
    if (err?.code === 126 || err?.code === 127) {
      throw new NoShellError(containerName);
    }
    // String fallback for docker versions that exit differently but do
    // phrase the problem on stderr.
    if (
      blob.includes('executable file not found') ||
      blob.includes('unable to start container process') ||
      (blob.includes('exec') && blob.includes('no such file'))
    ) {
      throw new NoShellError(containerName);
    }
    throw err;
  }
}

/**
 * List a directory inside the container. Uses busybox-friendly `ls`
 * flags so it works on alpine images too — `-la --color=never` would
 * fall over on busybox.
 */
export async function listDir(target: DockerFsTarget, relPath: string): Promise<DockerEntry[]> {
  const abs = joinAndValidate(target.rootDir, relPath);
  // POSIX `ls -lA` includes hidden files but not . and ..
  // Format columns: type/perms, links, owner, group, size, month, day, time/year, name
  // We split on whitespace and reassemble the name field (it might
  // contain spaces).
  const { stdout } = await dockerSh(
    target.containerName,
    `ls -lA --time-style=long-iso '${abs}' 2>/dev/null || echo "__DOCKCONTROL_ERR__"`,
  );
  if (stdout.includes('__DOCKCONTROL_ERR__')) {
    throw new Error(`Path '${relPath || '/'}' not found in container or not a directory`);
  }
  const entries: DockerEntry[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('total ')) continue;
    // Long-iso format: drwxr-xr-x  2 root root  4096 2025-12-12 18:32 name
    const m = line.match(
      /^([dlcbsp\-])([rwxsStT\-]{9})[+.]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/,
    );
    if (!m) continue;
    const [, typeChar, modeStr, sizeStr, date, time, nameField] = m;
    // Strip symlink target arrows: "linkname -> /target"
    const name = nameField.split(' -> ')[0];
    let type: DockerEntry['type'] = 'other';
    if (typeChar === '-') type = 'file';
    else if (typeChar === 'd') type = 'directory';
    else if (typeChar === 'l') type = 'symlink';
    // perms: convert rwxr-xr-x → 755. Symbolic-to-octal mapping.
    const triplet = (s: string) =>
      (s[0] === 'r' ? 4 : 0) + (s[1] === 'w' ? 2 : 0) + ((s[2] === 'x' || s[2] === 's' || s[2] === 't') ? 1 : 0);
    const perms =
      `${triplet(modeStr.slice(0, 3))}${triplet(modeStr.slice(3, 6))}${triplet(modeStr.slice(6, 9))}`;
    entries.push({
      name,
      path: (relPath ? relPath.replace(/\/+$/, '') + '/' : '') + name,
      type,
      size: Number(sizeStr) || 0,
      modifiedAt: `${date}T${time}:00Z`,
      permissions: perms,
    });
  }
  return entries;
}

/** True if the path exists and is a regular file. */
export async function stat(target: DockerFsTarget, relPath: string): Promise<{ exists: boolean; isFile: boolean; isDir: boolean; size: number }> {
  const abs = joinAndValidate(target.rootDir, relPath);
  try {
    const { stdout } = await dockerSh(
      target.containerName,
      `stat -c '%F|%s' '${abs}' 2>/dev/null || echo "MISSING"`,
    );
    const line = stdout.trim();
    if (!line || line === 'MISSING') return { exists: false, isFile: false, isDir: false, size: 0 };
    const [kind, size] = line.split('|');
    return {
      exists: true,
      isFile: kind === 'regular file' || kind === 'regular empty file',
      isDir: kind === 'directory',
      size: Number(size) || 0,
    };
  } catch {
    return { exists: false, isFile: false, isDir: false, size: 0 };
  }
}

/**
 * Read a text file. Caps at MAX_FILE_BYTES — anything larger falls back
 * to the "binary file, download to view" UX the host-fs side has too.
 */
export async function readFile(target: DockerFsTarget, relPath: string): Promise<string> {
  const abs = joinAndValidate(target.rootDir, relPath);
  // -c <bytes>+1 so we can detect oversized files; if cat returns more
  // than MAX_FILE_BYTES we tell the user it's too large.
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', target.containerName, 'sh', '-c', `head -c ${MAX_FILE_BYTES + 1} '${abs}'`],
    { timeout: 30_000, maxBuffer: MAX_FILE_BYTES + 1024, encoding: 'buffer' },
  );
  if (stdout.length > MAX_FILE_BYTES) {
    throw new Error('File too large to edit in-browser (>2 MiB) — open a terminal to view it');
  }
  return stdout.toString('utf-8');
}

/**
 * Write a text file. We pipe via stdin so the content never lands as
 * a shell argument (no length cap, no quote escaping).
 */
export async function writeFile(target: DockerFsTarget, relPath: string, content: string): Promise<void> {
  const abs = joinAndValidate(target.rootDir, relPath);
  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
    throw new Error('File too large (>2 MiB)');
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      ['exec', '-i', target.containerName, 'sh', '-c', `cat > '${abs}'`],
      { timeout: 30_000 },
      (err) => (err ? reject(err) : resolve()),
    );
    Readable.from(Buffer.from(content, 'utf-8')).pipe(child.stdin!);
  });
}

/**
 * Read a binary file by streaming `docker exec cat` directly. The
 * controller hands the stream to express. No size cap here because the
 * controller already enforces one on the response.
 */
export async function downloadFile(target: DockerFsTarget, relPath: string): Promise<{ filename: string; size: number; stream: NodeJS.ReadableStream }> {
  const abs = joinAndValidate(target.rootDir, relPath);
  const s = await stat(target, relPath);
  if (!s.exists) throw new Error('File not found');
  if (!s.isFile) throw new Error('Not a regular file');
  const child = execFile('docker', ['exec', target.containerName, 'cat', abs], {
    maxBuffer: 1024 * 1024 * 1024, // 1 GiB ceiling — UI capped lower
  });
  return {
    filename: abs.split('/').pop()?.replace(/[\r\n";\\]/g, '_') || 'file',
    size: s.size,
    stream: child.stdout!,
  };
}

/**
 * Copy a file OUT of the container to a host path via `docker cp` (no shell —
 * argv array). Used by the zip-extract flow to pull an archive out for
 * decoding on the API side (the image may have no `unzip`). The relPath is
 * validated/joined the same way as every other op; `docker cp` writes the file
 * to `hostPath` directly.
 */
export async function copyOut(
  target: DockerFsTarget,
  relPath: string,
  hostPath: string,
): Promise<void> {
  const abs = joinAndValidate(target.rootDir, relPath);
  await execFileAsync(
    'docker',
    ['cp', `${target.containerName}:${abs}`, hostPath],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
}

export async function mkdir(target: DockerFsTarget, relPath: string): Promise<void> {
  const abs = joinAndValidate(target.rootDir, relPath);
  await dockerSh(target.containerName, `mkdir -p '${abs}'`);
}

export async function remove(target: DockerFsTarget, relPath: string): Promise<void> {
  const abs = joinAndValidate(target.rootDir, relPath);
  // Defense: refuse to rm the root.
  if (abs === target.rootDir || abs === target.rootDir.replace(/\/+$/, '')) {
    throw new Error('Cannot delete the root');
  }
  await dockerSh(target.containerName, `rm -rf '${abs}'`);
}

export async function rename(target: DockerFsTarget, fromRel: string, toRel: string): Promise<void> {
  const fromAbs = joinAndValidate(target.rootDir, fromRel);
  const toAbs = joinAndValidate(target.rootDir, toRel);
  await dockerSh(target.containerName, `mv '${fromAbs}' '${toAbs}'`);
}

/**
 * chmod a path inside the container. `mode` is an integer in [0, 0o777]
 * (validated by the caller via parseChmodMode) — rendered as a 3-digit octal so
 * no shell metacharacter can appear. `recursive` adds -R for directories.
 */
export async function chmod(
  target: DockerFsTarget,
  relPath: string,
  mode: number,
  recursive: boolean,
): Promise<void> {
  const abs = joinAndValidate(target.rootDir, relPath);
  const octal = (mode & 0o777).toString(8).padStart(3, '0'); // e.g. "755"
  const flag = recursive ? '-R ' : '';
  // Refuse a symlink TARGET so chmod can't be pointed (via an in-container
  // symlink) at a file outside the browse root — parity with the host-fs and
  // agent paths which lstat-refuse symlinks. `-h`-style no-deref isn't portable
  // across busybox/coreutils, so we guard with a `test -L` precheck instead.
  await dockerSh(
    target.containerName,
    `if [ -L '${abs}' ]; then echo "refusing to chmod a symlink" >&2; exit 9; fi; chmod ${flag}${octal} '${abs}'`,
  );
}

/**
 * chown a path inside the container. `owner` is the pre-validated user[:group]
 * token (parseChownOwner) — it cannot contain shell metacharacters or
 * whitespace, so it is safe as a single unquoted argv-equivalent. We still wrap
 * the PATH in single quotes (joinAndValidate already rejects `'`).
 */
export async function chown(
  target: DockerFsTarget,
  relPath: string,
  owner: string,
  recursive: boolean,
): Promise<void> {
  const abs = joinAndValidate(target.rootDir, relPath);
  const flag = recursive ? '-R ' : '';
  // `owner` is validated to [a-z0-9_:-]/digits only (parseChownOwner), so it
  // carries no shell metacharacters — but we single-quote it anyway so the
  // no-injection guarantee is LOCAL to this line and survives any future
  // loosening of the regex (defense-in-depth). Also refuse a symlink target,
  // matching chmod above and the host-fs/agent paths. `chown` defaults to NOT
  // dereferencing the top-level symlink, but we refuse it outright for parity.
  await dockerSh(
    target.containerName,
    `if [ -L '${abs}' ]; then echo "refusing to chown a symlink" >&2; exit 9; fi; chown ${flag}'${owner}' '${abs}'`,
  );
}

/**
 * Upload a file via `docker cp` — STDIN tar stream is the cheapest way
 * to push arbitrary bytes without buffering them in process memory.
 * We tar a single entry on the fly: the ustar header needs the payload
 * size up-front, which the caller has from fs.stat on the temp file,
 * so the content itself is STREAMED from disk into docker cp's stdin
 * (header → file stream → padding → zero trailer). Peak memory is one
 * 512-byte header + stream chunks, regardless of upload size.
 */
export async function uploadFile(
  target: DockerFsTarget,
  relPath: string,
  filename: string,
  sourceFilePath: string,
): Promise<void> {
  // Validate path INCLUDING the destination name so `joinAndValidate`
  // catches `../whatever` injected via filename.
  const safeName = filename.replace(/[\x00-\x1f/\\']/g, '_');
  if (!safeName) throw new Error('Invalid filename');
  const targetRel = (relPath ? relPath.replace(/\/+$/, '') + '/' : '') + safeName;
  const targetAbs = joinAndValidate(target.rootDir, targetRel);

  // Push via stdin: `docker cp - <container>:<targetDir>`. We build a
  // POSIX tar archive with a single file entry whose path is the
  // basename — docker cp extracts INTO the target dir, so we ask it
  // to land at the parent dir and let the tar entry name be the file.
  const parentAbs = targetAbs.replace(/\/[^/]+$/, '') || '/';
  // tar with --transform would also work, but POSIX shell doesn't have
  // it everywhere. Build the archive ourselves: a 512-byte header +
  // streamed payload + padding to 512 + 1024 zero trailer.
  const st = await fs.promises.stat(sourceFilePath);
  if (!st.isFile()) throw new Error('Upload source is not a regular file');
  const size = st.size;
  const header = makeTarHeader(safeName, size);
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      ['cp', '-', `${target.containerName}:${parentAbs}`],
      { timeout: 10 * 60_000, maxBuffer: 4096 },
      (err) => (err ? reject(err) : resolve()),
    );
    const stdin = child.stdin!;
    // EPIPE from a dying docker process surfaces via the execFile
    // callback; swallow the duplicate stdin error so it doesn't crash
    // the process as an unhandled 'error' event.
    stdin.on('error', () => {});
    stdin.write(header);
    const src = fs.createReadStream(sourceFilePath);
    src.on('error', (err) => {
      try { child.kill(); } catch {}
      reject(err);
    });
    src.on('end', () => {
      const pad = (512 - (size % 512)) % 512;
      stdin.end(Buffer.alloc(pad + 1024));
    });
    // end:false — we still need to append padding + trailer after the
    // payload before closing stdin.
    src.pipe(stdin, { end: false });
  });
}

/**
 * Minimal POSIX (ustar) tar header for a SINGLE regular file entry of
 * `size` bytes. Skips fancy long-name support — uploads use the
 * validated short basename. Inlined here to avoid pulling in the `tar`
 * package for one call site. The caller streams the payload after this
 * header, then pads to a 512-byte boundary and appends the two 512-byte
 * zero blocks that terminate the archive.
 */
export function makeTarHeader(name: string, size: number): Buffer {
  if (name.length > 100) throw new Error('Filename too long for tar');
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar entry size');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf-8');
  header.write('000644 \0', 100, 8, 'ascii'); // mode
  header.write('000000 \0', 108, 8, 'ascii'); // uid
  header.write('000000 \0', 116, 8, 'ascii'); // gid
  // size in octal, NUL-terminated.
  const sizeOctal = size.toString(8).padStart(11, '0');
  header.write(sizeOctal + ' ', 124, 12, 'ascii');
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
  header.write(mtimeOctal + ' ', 136, 12, 'ascii');
  // typeflag '0' = regular file.
  header.write('0', 156, 1, 'ascii');
  header.write('ustar', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  // Checksum calculation: sum of all bytes in header treating the
  // checksum field itself as 8 spaces, then write octal back into
  // bytes 148..156.
  header.write('        ', 148, 8, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  const checksumOctal = sum.toString(8).padStart(6, '0');
  header.write(checksumOctal + '\0 ', 148, 8, 'ascii');
  return header;
}
