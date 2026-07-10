import { readFileSync, writeFileSync } from 'node:fs';

const root = process.cwd();
const checkOnly = process.argv.includes('--check');
const outputFile = 'THIRD_PARTY_NOTICES.md';
const sources = [
  { distribution: 'Hub', lockfile: 'package-lock.json' },
  { distribution: 'Console', lockfile: 'web-admin/package-lock.json' },
];

function packageName(path) {
  const marker = 'node_modules/';
  const tail = path.slice(path.lastIndexOf(marker) + marker.length);
  const parts = tail.split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function markdown(value) {
  return String(value).replaceAll('|', '\\|');
}

function collectPackages() {
  const packages = new Map();
  for (const source of sources) {
    const lock = JSON.parse(readFileSync(source.lockfile, 'utf8'));
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      if (!path || !entry?.version) continue;
      if (!entry.license) throw new Error(`${source.lockfile}: ${path} is missing license metadata`);
      const name = packageName(path);
      const key = `${source.distribution}\0${name}\0${entry.version}`;
      const dependencyClass = entry.dev ? 'build/test' : 'runtime';
      const previous = packages.get(key);
      packages.set(key, {
        distribution: source.distribution,
        name,
        version: entry.version,
        license: entry.license,
        dependencyClass: previous?.dependencyClass === 'runtime' ? 'runtime' : dependencyClass,
      });
    }
  }
  return [...packages.values()].sort((a, b) =>
    a.distribution.localeCompare(b.distribution) ||
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version),
  );
}

function render() {
  const rows = collectPackages().map((pkg) =>
    `| ${pkg.distribution} | [${markdown(pkg.name)}](https://www.npmjs.com/package/${pkg.name}) | ${markdown(pkg.version)} | ${markdown(pkg.license)} | ${pkg.dependencyClass} |`,
  );
  return `# Third-Party Notices

This document records open-source specifications, runtime components, and JavaScript packages used by BailingHub. It is generated from the repository lockfiles so dependency upgrades cannot silently leave the inventory stale.

Regenerate it with \`npm run notices:generate\` and verify it with \`npm run notices:check\`.

## Open Contract

- [Agent Capability Contract (ACC)](https://github.com/agent-capability/agent-capability-contract) is an implementation-neutral capability declaration contract licensed under Apache-2.0. BailingHub adopts ACC and distributes an implementation schema derived from the ACC v1 schema. The applicable ACC attribution is preserved in [NOTICE](NOTICE).

## Container Runtime Components

- BailingHub and its demo business service use the official [Node.js](https://github.com/nodejs/node) 22 Bookworm Slim image as their default container base. Node.js and the Debian packages in that image retain their own licenses and notices.
- The default Docker Compose topology runs [MySQL Community Server](https://www.mysql.com/products/community/) 8.4 as a separate service. The public mirror configured by BailingHub is a redistribution of the upstream MySQL image; operators may replace it through \`BAILING_MYSQL_IMAGE\`. MySQL Community Server is licensed by its upstream project under GPL terms and is not relicensed as part of BailingHub.

## JavaScript Dependency Inventory

The package license texts and copyright notices remain in the installed package distributions. The table below is an inventory, not a replacement for those upstream license files.

| Distribution | Package | Version | License | Class |
|---|---|---:|---|---|
${rows.join('\n')}

## No Endorsement

The names and marks of third-party projects belong to their respective owners. Their inclusion does not imply endorsement of BailingHub, and BailingHub does not claim ownership of those projects.
`;
}

const expected = render();
if (checkOnly) {
  const actual = readFileSync(outputFile, 'utf8');
  if (actual !== expected) {
    console.error(`${outputFile} is stale. Run npm run notices:generate.`);
    process.exit(1);
  }
  console.log(`✓ third-party notices are current (${collectPackages().length} package records)`);
} else {
  writeFileSync(outputFile, expected);
  console.log(`✓ wrote ${outputFile} (${collectPackages().length} package records)`);
}
