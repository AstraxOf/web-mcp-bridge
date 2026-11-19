/**
 * versioning.js — Qué versión de la extensión está cargada y si es la más reciente (sin dependencias; se prueba en tests/test_version.mjs).
 *
 * La extensión se carga desde la carpeta del repositorio, así que puede leer su propio `.git` (HEAD, ramas, packed-refs) y saber en qué
 * commit está sin ejecutar nada. La referencia «más reciente» es `origin/main` tal como la dejó el último `git fetch`.
 */

const SHA = /^[0-9a-f]{40}$/i;

/** Busca `refName` (p. ej. refs/heads/main) en el texto de `packed-refs`. */
export function packedRef(packedText, refName) {
  for (const line of String(packedText ?? '').split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === refName && SHA.test(sha)) return sha.toLowerCase();
  }
  return null;
}

/**
 * @param {{head:string|null, readRef:(name:string)=>string|null, packed:string|null}} src
 *   head = contenido de .git/HEAD; readRef = contenido de .git/<ref> (o null); packed = contenido de .git/packed-refs
 * @returns {{branch:string|null, commit:string|null, latest:string|null}}
 */
export function parseGit({ head, readRef, packed }) {
  const text = String(head ?? '').trim();
  const resolve = (ref) => {
    const loose = String(readRef(ref) ?? '').trim();
    return SHA.test(loose) ? loose.toLowerCase() : packedRef(packed, ref);
  };
  let branch = null;
  let commit = null;
  if (text.startsWith('ref:')) {
    const ref = text.slice(4).trim();
    branch = ref.replace(/^refs\/heads\//, '');
    commit = resolve(ref);
  } else if (SHA.test(text)) {
    commit = text.toLowerCase();                    // HEAD suelto (detached)
  }
  return { branch, commit, latest: resolve('refs/remotes/origin/main') };
}

const short = (c) => (c ? String(c).slice(0, 7) : '');

/**
 * Texto y estado para mostrar en el panel.
 * state: ok (al día con main) · old (en main pero hay commits nuevos) · branch (otra rama) · reload (hay una versión nueva en disco) · unknown
 */
export function versionInfo({ version, commit, branch, latest, bootCommit }) {
  const v = version ? `v${version}` : 'v?';
  if (!commit) return { state: 'unknown', label: v, title: `${v}\nCommit desconocido: la carpeta no tiene .git ni update-stamp.json.` };
  const label = `${v} · ${short(commit)}`;
  const lines = [`Versión ${v}`, `Commit ${commit}`, `Rama ${branch ?? '(HEAD suelto)'}`];
  if (latest) lines.push(`origin/main ${short(latest)}`);
  let state = 'unknown';
  let note = 'No se pudo comparar con main (aún no hay un git fetch).';
  if (bootCommit && bootCommit !== commit) {
    state = 'reload';
    lines.push(`Cargada con ${short(bootCommit)}`);
    note = 'Hay una versión nueva en disco: la extensión se recargará sola (o recárgala en chrome://extensions).';
  } else if (latest && commit === latest) {
    state = 'ok';
    note = 'Es la más reciente de main.';
  } else if (latest && branch === 'main') {
    state = 'old';
    note = `Hay commits nuevos en main (${short(latest)}): la tarea de actualización los bajará.`;
  } else if (latest) {
    state = 'branch';
    note = `Rama de trabajo «${branch}»: no es main (${short(latest)}) y no se actualiza sola.`;
  }
  lines.push('', note);
  return { state, label, title: lines.join('\n'), note };
}
