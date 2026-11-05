#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EXPECTED = [
  {
    id: 'aha-preview',
    commit: 'd63959f9c766258d7ce827e68f4ddd93d2797f99',
    features: 'chat-response,models-response,long-context-catalog,stream-meta,stream-delta,stream-tool-call,stream-usage,stream-done',
  },
  {
    id: 'sdk-v0.2.0',
    commit: '40bfabffb3f765046ceafad213a26a5754dbd6b9',
    features: 'chat-response,models-response,long-context-catalog,stream-meta,stream-delta,stream-tool-call,stream-tool-call-delta,stream-usage,stream-done',
  },
];

function parse(markdown) {
  const heading = '#### Released Rust response-decoder contract';
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error('missing released Rust response-decoder contract heading');
  const section = markdown.slice(start + heading.length).split(/\n#{1,4} /, 1)[0];
  const sectionLines = section.split('\n');
  const tableStart = sectionLines.findIndex((line) => line.startsWith('|'));
  const tableLines = tableStart < 0 ? [] : sectionLines.slice(tableStart);
  const tableEnd = tableLines.findIndex((line) => !line.startsWith('|'));
  const lines = tableEnd < 0 ? tableLines : tableLines.slice(0, tableEnd);
  const header = '| SDK id | Immutable commit | Supported response features |';
  if (lines[0] !== header || lines[1] !== '|---|---|---|') {
    throw new Error('malformed released SDK register table header');
  }
  const rows = lines.slice(2).map((line) => {
    const match = /^\| `([a-z0-9.-]+)` \| `([0-9a-f]{40})` \| `([a-z0-9,-]+)` \|$/.exec(line);
    if (!match) throw new Error(`malformed released SDK register row: ${line}`);
    return { id: match[1], commit: match[2], features: match[3] };
  });
  if (rows.length !== EXPECTED.length) throw new Error(`expected exactly ${EXPECTED.length} supported SDK revisions, found ${rows.length}`);
  const ids = rows.map((row) => row.id);
  const commits = rows.map((row) => row.commit);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate released SDK id');
  if (new Set(commits).size !== commits.length) throw new Error('duplicate released SDK commit');
  for (let i = 0; i < EXPECTED.length; i += 1) {
    assert.deepEqual(rows[i], EXPECTED[i], `unsupported or out-of-order released SDK inventory at row ${i + 1}`);
  }
  return rows;
}

function selfTest() {
  const table = [
    '| SDK id | Immutable commit | Supported response features |',
    '|---|---|---|',
    ...EXPECTED.map(({ id, commit, features }) => `| \`${id}\` | \`${commit}\` | \`${features}\` |`),
  ].join('\n');
  assert.equal(parse(`#### Released Rust response-decoder contract\n${table}\n\n### next`).length, 2);
  for (const [name, bad] of [
    ['missing release', table.replace(/\n\| `sdk-v0\.2\.0`[^\n]+/, '')],
    ['extra release', `${table}\n| \`future-release\` | \`${'a'.repeat(40)}\` | \`chat-response\` |`],
    ['duplicate release', `${table}\n${table.split('\n')[2]}`],
    ['wrong immutable revision', table.replace(EXPECTED[0].commit, 'b'.repeat(40))],
    ['unsupported feature inventory', table.replace('stream-tool-call-delta,', 'stream-tool-call-delta,stream-future,' )],
    ['malformed row', table.replace(EXPECTED[0].commit, 'not-a-commit')],
  ]) {
    assert.throws(() => parse(`#### Released Rust response-decoder contract\n${bad}\n\n### next`), undefined, name);
  }
}

if (process.argv.includes('--self-test')) selfTest();
else {
  const path = process.argv[2];
  if (!path) throw new Error('usage: released-sdk-register.mjs [--self-test | RELEASES.md]');
  for (const row of parse(readFileSync(path, 'utf8'))) {
    process.stdout.write(`${row.id}\t${row.commit}\t${row.features}\n`);
  }
}
