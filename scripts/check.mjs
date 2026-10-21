#!/usr/bin/env node
/**
 * Release check for dsh-reminding.
 *
 * Validates the npm manifest, the bundle patch, the exported files, the
 * locale/icon display resources and both plugin halves without starting DSH.
 * Prints every failure before exiting non-zero, so CI reports all problems in
 * one run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (file) => readFileSync(join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json'))

let total = 0
const failures = []

/**
 * Record one assertion.
 * @param label - human-readable assertion description.
 * @param condition - assertion result.
 */
function check(label, condition) {
  total += 1
  if (!condition) failures.push(label)
}

/**
 * Expand one `files`/`exports` entry to concrete paths.
 * Supports a single `*` per pattern, which is all this manifest uses.
 * @param pattern - POSIX-style relative pattern.
 * @returns matching relative paths.
 */
function expand(pattern) {
  if (!pattern.includes('*')) return [pattern]
  const slash = pattern.lastIndexOf('/')
  const dir = slash === -1 ? '.' : pattern.slice(0, slash)
  const base = pattern.slice(slash + 1)
  const source = base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const matcher = new RegExp(`^${source}$`)
  try {
    return readdirSync(join(root, dir))
      .filter((name) => matcher.test(name))
      .map((name) => (dir === '.' ? name : `${dir}/${name}`))
  } catch {
    return []
  }
}

/** Assert that every entry of a manifest list resolves to an existing file. */
function checkManifestList(label, list) {
  const files = list.flatMap(expand)
  check(`${label} is non-empty`, files.length > 0)
  for (const file of files) {
    const path = join(root, file)
    check(`${label} entry exists: ${file}`, existsSync(path) && statSync(path).isFile())
  }
}

// ---------------------------------------------------------------------------
// npm metadata.

check('name is a lowercase unscoped package name', /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name))
check('version is semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))
check('description is present and descriptive', typeof pkg.description === 'string' && pkg.description.trim().length >= 40)
check('license is MIT', pkg.license === 'MIT')
check('author is present', typeof pkg.author === 'string' && pkg.author.trim() !== '')
check('homepage is an https URL', typeof pkg.homepage === 'string' && pkg.homepage.startsWith('https://'))
check('repository url is present', typeof pkg.repository?.url === 'string' && pkg.repository.url.startsWith('git+https://'))
check('bugs url is present', typeof pkg.bugs?.url === 'string' && pkg.bugs.url.startsWith('https://'))
check('keywords are declared', Array.isArray(pkg.keywords) && pkg.keywords.length >= 10)
check('keywords are unique lowercase strings', Array.isArray(pkg.keywords)
  && new Set(pkg.keywords).size === pkg.keywords.length
  && pkg.keywords.every((keyword) => typeof keyword === 'string' && keyword === keyword.toLowerCase()))
check('package is publishable (no private flag)', pkg.private !== true)
check('publishConfig is public', pkg.publishConfig?.access === 'public')
check('engines.node is declared', typeof pkg.engines?.node === 'string')
check('engines.dsh is declared', typeof pkg.engines?.dsh === 'string')
check('scripts.check is declared', typeof pkg.scripts?.check === 'string')
check('scripts.test is declared', typeof pkg.scripts?.test === 'string')
check('scripts.prepublishOnly runs check + test', typeof pkg.scripts?.prepublishOnly === 'string'
  && pkg.scripts.prepublishOnly.includes('check')
  && pkg.scripts.prepublishOnly.includes('test'))
check('main points at index.js', pkg.main === 'index.js')
check('type is module', pkg.type === 'module')

// ---------------------------------------------------------------------------
// DSH manifest.

check('dsh.bundle.patch is declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform is web', pkg.dsh?.client?.platform === 'web')
check('dsh.client loads immediately', pkg.dsh?.client?.immediately === true)
check('dsh.client declares inject dependencies', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0)
check('compatibility declares the tested DSH release', ['compatible', 'incompatible', 'unknown']
  .includes(pkg.dsh?.compatibility?.dshReleases?.['0.2.1-rc.2']))
check('manifestVersion is declared', pkg.dsh?.manifestVersion === 1)

// ---------------------------------------------------------------------------
// Published and exported files.

check('files is declared', Array.isArray(pkg.files) && pkg.files.length > 0)
checkManifestList('files', Array.isArray(pkg.files) ? pkg.files : [])
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
  check(`files includes ${required}`, Array.isArray(pkg.files) && pkg.files.includes(required))
}
checkManifestList('exports', Object.values(pkg.exports ?? {}).filter((target) => typeof target === 'string'))
check('README documents the package', read('README.md').includes(pkg.name))
check('LICENSE is the MIT license', read('LICENSE').startsWith('MIT License'))

// ---------------------------------------------------------------------------
// Bundle patch.

const patch = read('cordis.patch.yml')
check('patch inserts the plugin row', /^\s*-\s*id:\s*dsh-reminding\s*$/m.test(patch))
check('patch names the package', /name:\s*['"]dsh-reminding['"]/.test(patch))

// ---------------------------------------------------------------------------
// Display resources.

const icon = read('icon.svg')
check('icon is an SVG document', icon.trimStart().startsWith('<svg') && icon.includes('</svg>'))
check('icon fits the 256 KiB limit', statSync(join(root, 'icon.svg')).size <= 256 * 1024)

const localeDocs = {}
for (const locale of ['zh', 'en']) {
  const doc = JSON.parse(read(`locale/${locale}.json`))
  localeDocs[locale] = doc
  check(`locale/${locale}.json declares meta.title`, typeof doc?.meta?.title === 'string' && doc.meta.title.trim() !== '')
  check(`locale/${locale}.json declares meta.description`, typeof doc?.meta?.description === 'string' && doc.meta.description.trim() !== '')
}
check('locale titles are localized, not copies', localeDocs.zh?.meta?.title !== localeDocs.en?.meta?.title)

// ---------------------------------------------------------------------------
// Plugin halves.

const host = await import(pathToFileURL(join(root, 'index.js')).href)
check('host exports apply()', typeof host.apply === 'function')
check('host injects webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))

const client = read('client.js')
check('client registers through the module loader', /window\.__ModuleLoader__\.load\s*\(\s*\{/.test(client))
check('client id matches the package name', new RegExp(`id:\\s*['"]${pkg.name.replace(/[.]/g, '\\.')}['"]`).test(client))
check('client imports no Harness Client package', !/require\(\s*['"]@deepseek-ai\//.test(client))
check('client uses only theme tokens for styling', !/--dsw-(?!alias-)[a-z-]+/.test(client) && client.includes('var(--dsw-alias-'))

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`check: ${failures.length} of ${total} assertions failed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`check: ${total} assertions passed`)
